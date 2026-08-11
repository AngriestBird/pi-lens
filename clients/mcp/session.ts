/**
 * Tier 2 of the MCP path: drive pi-lens's *real* lifecycle handlers
 * (`handleSessionStart`, `handleTurnEnd`) instead of re-implementing the runners
 * they orchestrate. This is what exposes the layers the per-edit dispatch slice
 * doesn't — session-start warms the dominant-language LSP (so warm `analyze` is
 * LSP-complete), establishes the error-debt baseline + complexity baselines, and
 * kicks off knip/jscpd/type-coverage/dep/secrets scans; turn-end runs
 * knip incrementally, dep-circular, tests, cascade, and the
 * actionable/code-quality aggregation.
 *
 * The handlers don't return findings — they emit them through the same
 * cache/context bridge pi consumes (`consume*` from runtime-context). We drive
 * the handler, then consume that bridge and hand the text back as the tool result.
 *
 * The host coupling stays thin: a `getFlag` shim, no-op notify/dbg/log, a
 * persistent RuntimeCoordinator + CacheManager (so baselines/turn-state survive
 * across calls, like a real session), and the bootstrap client bundle.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AstGrepClient } from "../ast-grep-client.js";
import { type BootstrapClients, loadBootstrapClients } from "../bootstrap.js";
import {
	CacheManager,
	MCP_TURN_STATE_OWNER_ID,
	type TurnStateOwner,
} from "../cache-manager.js";
import { resetDispatchBaselines } from "../dispatch/integration.js";
import { resetFormatService } from "../format-service.js";
import { getLSPService, resetLSPService } from "../lsp/index.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
	peekTestFindings,
	peekTurnEndFindings,
} from "../runtime-context.js";
import { RuntimeCoordinator } from "../runtime-coordinator.js";
import { handleSessionStart } from "../runtime-session.js";
import { handleTurnEnd } from "../runtime-turn.js";
import { createMcpHost } from "./host-shim.js";

interface McpSessionContext {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	astGrepClient: AstGrepClient;
	clients: BootstrapClients;
}

let contextPromise: Promise<McpSessionContext> | undefined;

/** Lazily build (once) the persistent session context shared across MCP calls. */
export function getMcpSessionContext(): Promise<McpSessionContext> {
	contextPromise ??= (async () => ({
		runtime: new RuntimeCoordinator(),
		cacheManager: new CacheManager(),
		astGrepClient: new AstGrepClient(),
		clients: await loadBootstrapClients(),
	}))();
	return contextPromise;
}

/** Test hook — drop the cached context so a fresh one is built next call. */
export function _resetMcpSessionContext(): void {
	contextPromise = undefined;
}

const noop = (): void => {};

function joinMessages(
	consumed: { messages: Array<{ content: string }> } | undefined,
): string | undefined {
	if (!consumed?.messages?.length) return undefined;
	return consumed.messages.map((message) => message.content).join("\n\n");
}

export interface SessionStartOutcome {
	guidance?: string;
	errorDebtBaseline?: { testsPassed: boolean; buildPassed: boolean };
	aliveLspClients: number;
}

/**
 * Run pi-lens's real session_start. Much of the work (scans, baseline, LSP warm)
 * runs in the background, so the immediate return carries the synchronous
 * guidance + whatever baseline/LSP state is ready; query `pilens_diagnostics` /
 * `pilens_health` afterwards for the scan results as they land.
 */
export async function runSessionStart(
	cwd: string,
): Promise<SessionStartOutcome> {
	const ctx = await getMcpSessionContext();
	const host = createMcpHost(undefined, cwd);

	await handleSessionStart({
		ctxCwd: cwd,
		// The MCP server has no TUI keystroke latency to protect, so the
		// first-call-quick heuristic must not apply. Force "full" mode so
		// the dominant-language LSP pre-warm, scans, and error-debt baseline
		// all run on the first (and only) session_start of the process.
		// An explicit PI_LENS_STARTUP_MODE env var still wins (handled in
		// handleSessionStart — the override is only checked when the env var
		// is unset).
		startupModeOverride: "full",
		getFlag: host.getFlag,
		notify: noop,
		dbg: noop,
		log: noop,
		runtime: ctx.runtime,
		metricsClient: ctx.clients.metricsClient,
		cacheManager: ctx.cacheManager,
		todoScanner: ctx.clients.todoScanner,
		astGrepClient: ctx.astGrepClient,
		biomeClient: ctx.clients.biomeClient,
		ruffClient: ctx.clients.ruffClient,
		knipClient: ctx.clients.knipClient,
		jscpdClient: ctx.clients.jscpdClient,
		deadCodeClients: ctx.clients.deadCodeClients,
		govulncheckClient: ctx.clients.govulncheckClient,
		gitleaksClient: ctx.clients.gitleaksClient,
		trivyClient: ctx.clients.trivyClient,
		opengrepClient: ctx.clients.opengrepClient,
		depChecker: ctx.clients.depChecker,
		testRunnerClient: ctx.clients.testRunnerClient,
		goClient: ctx.clients.goClient,
		rustClient: ctx.clients.rustClient,
		ensureTool: async (name: string) =>
			(await import("../installer/index.js")).ensureTool(name),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: (cwdArg?: string) =>
			resetDispatchBaselines(cwdArg ?? cwd),
		resetLSPService,
	});

	const baseline = ctx.runtime.errorDebtBaseline;
	return {
		guidance: joinMessages(consumeSessionStartGuidance(ctx.cacheManager, cwd)),
		errorDebtBaseline: baseline
			? { testsPassed: baseline.testsPassed, buildPassed: baseline.buildPassed }
			: undefined,
		aliveLspClients: getLSPService().getAliveClientCount(),
	};
}

export interface TurnEndOutcome {
	turnEnd?: string;
	tests?: string;
	filesRegistered: number;
}

export interface TurnEndDelivery {
	outcome: TurnEndOutcome;
	/** Capability required by a separate one-shot ack request. */
	deliveryId?: string;
}

interface TurnEndTransaction {
	outcome: TurnEndOutcome;
	commit: () => void;
}

interface PendingTurnEndDelivery {
	cwd: string;
	transaction: TurnEndTransaction;
}

const TURN_END_QUEUE_WAIT_MS = 5_000;

interface QueueItem<T> {
	work: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A bounded, cancellable serial queue. A turn_end mutates shared runtime and
 * cache state, so concurrent passes are unsafe; a disconnected/hung pass must
 * nevertheless not accumulate an unbounded tail of Stop requests.
 */
class TurnEndQueue {
	private running = false;
	private pending: QueueItem<unknown>[] = [];

	enqueue<T>(work: () => Promise<T>, waitMs = TURN_END_QUEUE_WAIT_MS): Promise<T> {
		if (this.pending.length >= 1) {
			return Promise.reject(new Error("turn_end queue is busy"));
		}
		return new Promise<T>((resolve, reject) => {
			const item: QueueItem<T> = {
				work,
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.pending.indexOf(item as QueueItem<unknown>);
					if (index === -1) return;
					this.pending.splice(index, 1);
					reject(new Error("turn_end queue wait timed out"));
				}, waitMs),
			};
			item.timer.unref();
			this.pending.push(item as QueueItem<unknown>);
			this.drain();
		});
	}

	private drain(): void {
		if (this.running) return;
		const item = this.pending.shift();
		if (!item) return;
		clearTimeout(item.timer);
		this.running = true;
		void item
			.work()
			.then(item.resolve, item.reject)
			.finally(() => {
				this.running = false;
				this.drain();
			});
	}

	reset(): void {
		for (const item of this.pending.splice(0)) {
			clearTimeout(item.timer);
			item.reject(new Error("turn_end queue reset"));
		}
		this.running = false;
	}
}

const turnEndQueue = new TurnEndQueue();
const pendingTurnEndDeliveries = new Map<string, PendingTurnEndDelivery>();

/**
 * Run pi-lens's real turn_end over the files edited this "turn". The handler
 * reads edited files from turn-state, so we register the caller-supplied files
 * first (a full-file range, importsChanged=true so dep/knip re-check broadly).
 */
async function runTurnEndNow(
	cwd: string,
	files: string[] = [],
	deferredDelivery = false,
): Promise<TurnEndTransaction> {
	const ctx = await getMcpSessionContext();
	const host = createMcpHost(undefined, cwd);

	let registered = 0;
	for (const file of files) {
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		let lineCount = 1;
		try {
			lineCount = fs.readFileSync(abs, "utf8").split("\n").length;
		} catch {
			continue; // unreadable / deleted — skip
		}
		ctx.cacheManager.addModifiedRange(
			abs,
			{ start: 1, end: lineCount },
			true,
			cwd,
			MCP_TURN_STATE_OWNER_ID,
			"mcp",
		);
		registered++;
	}

	const owner: TurnStateOwner = {
		kind: "mcp",
		id: MCP_TURN_STATE_OWNER_ID,
		pid: process.pid,
		lastSeen: new Date().toISOString(),
	};

	await handleTurnEnd({
		ctxCwd: cwd,
		getFlag: host.getFlag,
		dbg: noop,
		runtime: ctx.runtime,
		cacheManager: ctx.cacheManager,
		knipClient: ctx.clients.knipClient,
		deadCodeClients: ctx.clients.deadCodeClients,
		depChecker: ctx.clients.depChecker,
		testRunnerClient: ctx.clients.testRunnerClient,
		owner,
		resetLSPService,
		resetFormatService,
	});

	const outcome: TurnEndOutcome = deferredDelivery
		? {
			turnEnd: joinMessages(peekTurnEndFindings(ctx.cacheManager, cwd)),
			tests: joinMessages(peekTestFindings(ctx.cacheManager, cwd)),
			filesRegistered: registered,
		}
		: {
			turnEnd: joinMessages(consumeTurnEndFindings(ctx.cacheManager, cwd)),
			tests: joinMessages(consumeTestFindings(ctx.cacheManager, cwd)),
			filesRegistered: registered,
		};

	return {
		outcome,
		commit: () => {
			if (!deferredDelivery) return;
			consumeTurnEndFindings(ctx.cacheManager, cwd);
			consumeTestFindings(ctx.cacheManager, cwd);
		},
	};
}

/**
 * Run a normal MCP turn_end. Its caller owns the tool response, so the
 * historical consume-on-return behavior remains unchanged.
 */
export function runTurnEnd(
	cwd: string,
	files: string[] = [],
): Promise<TurnEndOutcome> {
	return turnEndQueue.enqueue(async () =>
		(await runTurnEndNow(cwd, files)).outcome,
	);
}

/** A result with no findings needs no durable delivery transaction. */
function hasTurnEndFindings(outcome: TurnEndOutcome): boolean {
	return Boolean(outcome.turnEnd || outcome.tests);
}

function pendingForCwd(cwd: string): [string, PendingTurnEndDelivery] | undefined {
	for (const [deliveryId, delivery] of pendingTurnEndDeliveries) {
		if (delivery.cwd === cwd) return [deliveryId, delivery];
	}
	return undefined;
}

/**
 * Run the Stop-hook pass as a durable delivery transaction. The result is
 * acknowledged through a separate one-shot IPC request. Until that request
 * arrives, the findings cache is deliberately left unconsumed; a client
 * timeout, socket close, or server restart therefore leaves the result for a
 * later Stop request instead of losing it between execution and reply.
 */
export function runTurnEndForIpc(
	cwd: string,
): Promise<TurnEndDelivery> {
	return turnEndQueue.enqueue(async () => {
		const pending = pendingForCwd(cwd);
		if (pending) {
			return { outcome: pending[1].transaction.outcome, deliveryId: pending[0] };
		}

		const ctx = await getMcpSessionContext();
		const cachedOutcome: TurnEndOutcome = {
			turnEnd: joinMessages(peekTurnEndFindings(ctx.cacheManager, cwd)),
			tests: joinMessages(peekTestFindings(ctx.cacheManager, cwd)),
			filesRegistered: 0,
		};
		const transaction = hasTurnEndFindings(cachedOutcome)
			? {
					outcome: cachedOutcome,
					commit: () => {
						consumeTurnEndFindings(ctx.cacheManager, cwd);
						consumeTestFindings(ctx.cacheManager, cwd);
					},
				}
			: await runTurnEndNow(cwd, [], true);

		if (!hasTurnEndFindings(transaction.outcome)) {
			return { outcome: transaction.outcome };
		}

		const deliveryId = crypto.randomUUID();
		pendingTurnEndDeliveries.set(deliveryId, { cwd, transaction });
		return { outcome: transaction.outcome, deliveryId };
	});
}

/** Commit exactly one admitted delivery capability. */
export function acknowledgeTurnEnd(cwd: string, deliveryId: string): boolean {
	const delivery = pendingTurnEndDeliveries.get(deliveryId);
	if (!delivery || delivery.cwd !== cwd) return false;
	pendingTurnEndDeliveries.delete(deliveryId);
	delivery.transaction.commit();
	return true;
}

/** Test hook — drop pending requests so one failed test cannot wedge the rest. */
export function _resetTurnEndChain(): void {
	turnEndQueue.reset();
	pendingTurnEndDeliveries.clear();
}
