// flake-shape: real-process-spawn — a HEAD move exists only in a real repository that git checks out; a stubbed git could not rewrite the files the look lists in its delta.
/**
 * #4535 slice 2: the two detectors that still named a consumer now publish.
 *
 * Before this slice the HEAD look (`lookAtHead`) and the bash write path
 * (`handleToolResult`'s bash branch) each drove the LSP consumer themselves:
 * filter the population to held documents, send the stale ones to the primary
 * servers and wait out their drain barrier, then run the drift pass detached.
 * Both call sites are deleted; the publish is the only delivery, so these
 * cases drive the real detector entry points (`resyncHeadMove`, the two hook
 * handlers) and assert the record a subscriber receives and the calls the LSP
 * subscriber makes, through a service double at the host boundary.
 *
 * The red half of every case here is the publish itself: on base, neither
 * detector publishes anything, so the observer sees no record and no origin
 * ever reaches a subscriber.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { hashContentBytes } from "../../clients/content-stamp.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import {
	BASH_RECOVERY_DRIFT_SOURCE,
	BASH_WRITE_SOURCE,
	LSP_CONSUMER,
	readHeldDocumentsAnswer,
} from "../../clients/disk-change-subscribers.js";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import { configureLspServiceLifecycle } from "../../clients/lsp/service-singleton.js";
import { resetWorkspaceDiagnosticsCacheSession } from "../../clients/lsp/workspace-diagnostics-session.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import {
	observeGitHead,
	resetOpaqueMutationState,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	handleToolResult,
	resyncHeadMove,
} from "../../clients/runtime-tool-result.js";
import { execFileSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

interface ServiceCalls {
	primaries: Array<{ paths: string[]; drainMs: number }>;
	drift: Array<{ paths: string[]; maxPasses: number | undefined }>;
}

interface Harness {
	root: string;
	runtime: RuntimeCoordinator;
	publishes: DiskChange[];
	calls: ServiceCalls;
	/** Everything a case must undo, in order. */
	cleanups: Array<() => void>;
}

let tmp: string;

function git(cwd: string, ...args: string[]): string {
	return String(
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.local",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.local",
			},
		}),
	).trim();
}

/**
 * One case's world: a project directory, a real coordinator, a service double
 * recording the two LSP consumer calls, and a subscriber that records every
 * publish. The LSP service is the host boundary (a real one would spawn a
 * server per case); everything the detectors do — git, the baseline, the
 * publisher, the change log — is real.
 */
function harness(name: string, held: string[]): Harness {
	const root = path.join(tmp, name);
	fs.mkdirSync(root, { recursive: true });
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	resetDegradationLedger();
	resetOpaqueMutationState();
	resetWorkspaceDiagnosticsCacheSession(0);
	const publishes: DiskChange[] = [];
	const calls: ServiceCalls = { primaries: [], drift: [] };
	const cleanups: Array<() => void> = [];
	cleanups.push(
		subscribeDiskChange("slice2-observes-publish", (change) => {
			publishes.push(change);
		}),
	);
	resetLSPService();
	const service = makeLspServiceDouble({
		getOpenDocumentPaths: () => held,
		getTrackedContent: () => ({ hash: "the-bytes-the-server-holds" }),
		resyncHeldPrimaries: async (paths: readonly string[], drainMs: number) => {
			calls.primaries.push({ paths: [...paths], drainMs });
			return { sent: paths.length, drained: true };
		},
		resyncGitChangedFiles: async (
			paths: readonly string[],
			options: { maxPasses?: number } = {},
		) => {
			calls.drift.push({ paths: [...paths], maxPasses: options.maxPasses });
			return new Map<string, string>([["resynced", "resynced"]]);
		},
	});
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	getLSPService();
	return { root, runtime, publishes, calls, cleanups };
}

beforeEach(() => {
	// The checkout, not the harness tmpdir: a worker sandbox allows real Git
	// writes only inside its own worktree. The prefix is this file's own (the
	// #4552 fixture convention), every case removes its root, and the fixture
	// repo carries its own `.git` so no project-root walk escapes it.
	tmp = fs.mkdtempSync(path.join(process.cwd(), ".probe-home-4535-slice2-"));
});

afterEach(() => {
	resetLSPService();
	fs.rmSync(tmp, { recursive: true, force: true });
});

const headKey = (h: Harness) => `slice2|${h.root}`;

/** One look, as the hooks drive it. */
function look(
	h: Harness,
	trigger: "tool_call" | "tool_result" = "tool_call",
): Promise<void> {
	return resyncHeadMove({
		root: h.root,
		key: headKey(h),
		trigger,
		label: trigger === "tool_call" ? "read" : "git checkout B",
	});
}

/**
 * A repository on branch `A` whose branch `B` rewrites `lib.ts`, with the
 * session's first look already taken and branch `B` already checked out: the
 * next look is the one that sees a move (a first observation only records
 * HEAD).
 */
async function repoAfterMove(h: Harness): Promise<string> {
	const dir = h.root;
	fs.writeFileSync(path.join(dir, "lib.ts"), "export const v = 1;\n");
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	git(dir, "init", "-q", "-b", "A");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	git(dir, "branch", "B");
	git(dir, "checkout", "-q", "B");
	fs.writeFileSync(path.join(dir, "lib.ts"), "export const v = 2;\n");
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n\nmore\n");
	git(dir, "commit", "-qam", "B");
	git(dir, "checkout", "-q", "A");
	await look(h);
	git(dir, "checkout", "-q", "B");
	return dir;
}

describe("the HEAD look publishes instead of calling the LSP consumer", () => {
	it("publishes the moved delta and the LSP consumer resyncs the held document", async () => {
		const dir = path.join(tmp, "head-move");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move", [normalizeMapKey(lib)]);
		await repoAfterMove(h);

		await look(h, "tool_result");

		const moved = h.publishes.filter((change) => change.origin === "head-move");
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatchObject({
			root: normalizeMapKey(dir),
			kind: "inferred",
			// A HEAD move records no mutation (#4493): the publish carries no
			// sequence, and a subscriber must read 0 as "no seq evidence".
			seq: 0,
		});
		expect([...(moved[0]?.paths ?? [])]).toEqual(
			expect.arrayContaining([normalizeMapKey(lib)]),
		);
		// The held document is the only one that reaches the primary phase.
		expect(h.calls.primaries).toEqual([
			{
				paths: [normalizeMapKey(lib)],
				drainMs: HOOK_WALL_BUDGET_MS.tool_result_read_only,
			},
		]);
		await expect.poll(() => h.calls.drift.length, { timeout: 5000 }).toBe(1);
		expect(h.calls.drift[0]).toEqual({
			paths: [normalizeMapKey(lib)],
			maxPasses: 16,
		});
	}, 30_000);

	it("publishes an unlistable delta as unenumerable so no held document is skipped", async () => {
		const dir = path.join(tmp, "head-move-unknown");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move-unknown", [normalizeMapKey(lib)]);
		await repoAfterMove(h);
		// The old HEAD is garbage, so `git diff` fails: the delta is unknown.
		observeGitHead(headKey(h), "0".repeat(40));

		await look(h);

		const moved = h.publishes.filter((change) => change.origin === "head-move");
		expect(moved).toHaveLength(1);
		expect(moved[0]?.paths).toBe("unknown");
		// An unknown population leaves every held document as a candidate.
		expect(h.calls.primaries.map((call) => call.paths)).toEqual([
			[normalizeMapKey(lib)],
		]);
	}, 30_000);

	it("sends nothing and starts no drift pass when the move leaves held bytes current", async () => {
		const dir = path.join(tmp, "head-move-current");
		const lib = path.join(dir, "lib.ts");
		const h = harness("head-move-current", [normalizeMapKey(lib)]);
		await repoAfterMove(h);
		// A second service answer: the server already holds the disk bytes.
		configureLspServiceLifecycle<Record<string, unknown>>({
			create: () =>
				makeLspServiceDouble({
					getOpenDocumentPaths: () => [normalizeMapKey(lib)],
					getTrackedContent: () => ({
						hash: hashContentBytes(
							Buffer.from(fs.readFileSync(lib, "utf8"), "utf8"),
						),
					}),
					resyncHeldPrimaries: async (paths: readonly string[]) => {
						h.calls.primaries.push({ paths: [...paths], drainMs: 0 });
						return { sent: paths.length, drained: true };
					},
					resyncGitChangedFiles: async () => new Map(),
				}),
			beforeReset: () => undefined,
			destroy: async () => undefined,
		});
		resetLSPService();
		getLSPService();

		await look(h, "tool_result");

		expect(
			h.publishes.filter((change) => change.origin === "head-move"),
		).toHaveLength(1);
		expect(h.calls.primaries).toEqual([]);
		expect(h.calls.drift).toEqual([]);
	}, 30_000);
});

describe("a bash command's written documents publish instead of calling the LSP consumer", () => {
	function sessionFor(h: Harness) {
		let n = 0;
		const callDeps = (input: unknown, toolCallId: string) =>
			({
				event: { toolName: "bash", toolCallId, input },
				ctx: { cwd: h.root },
				lensEnabled: true,
				getFlag: () => false,
				dbg: () => {},
				runtime: h.runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
				sessionId: "slice2-session",
			}) as Parameters<typeof handleToolCall>[0];
		const resultDeps = (command: string, toolCallId: string) =>
			({
				event: {
					toolName: "bash",
					toolCallId,
					input: { command },
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime: h.runtime,
				cacheManager: new CacheManager(false),
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
				sessionId: "slice2-session",
			}) as unknown as Parameters<typeof handleToolResult>[0];
		return async (command: string, run: () => void): Promise<void> => {
			const toolCallId = `slice2-c${++n}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps({ command }, toolCallId)),
			);
			run();
			await handleToolResult(resultDeps(command, toolCallId));
		};
	}

	it("publishes the written set for the primary phase from a parser-recognized write", async () => {
		const target = path.join(tmp, "bash-write", "a.ts");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "export const a = 1;\n");
		const file = normalizeMapKey(target);
		const h = harness("bash-write", [file]);

		await sessionFor(h)("sed -i s/1/2/ a.ts", () => {
			fs.writeFileSync(target, "export const a = 2;\n");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "bash-recovery",
		);
		const primary = published.filter((change) =>
			change.sources.includes(BASH_WRITE_SOURCE),
		);
		expect(primary).toHaveLength(1);
		expect(primary[0]).toMatchObject({ kind: "inferred", seq: 0 });
		expect([...(primary[0]?.paths ?? [])]).toEqual([file]);
		// The LSP consumer observed the publish: the held, stale document went
		// to the primary before the synthetic dispatch below it.
		expect(h.calls.primaries).toEqual([
			{ paths: [file], drainMs: HOOK_WALL_BUDGET_MS.tool_result_edit },
		]);
		// A parser-recognized write has no recovered set, so no drift pass.
		expect(
			published.filter((change) =>
				change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE),
			),
		).toEqual([]);
	}, 30_000);

	it("publishes the recovered set for the detached drift pass, after the primary phase", async () => {
		const dir = path.join(tmp, "bash-recovery");
		const h = harness("bash-recovery", [
			normalizeMapKey(path.join(dir, "b.ts")),
		]);
		const target = path.join(dir, "b.ts");
		fs.writeFileSync(target, "export const b = 1;\n");
		const file = normalizeMapKey(target);

		await sessionFor(h)("node codemod.mjs", () => {
			fs.writeFileSync(target, "export const b = 2;\n");
		});

		const published = h.publishes.filter(
			(change) => change.origin === "bash-recovery",
		);
		const drift = published.filter((change) =>
			change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE),
		);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({ kind: "inferred", seq: 0 });
		expect([...(drift[0]?.paths ?? [])]).toEqual([file]);
		const order = published.map((change) => change.sources[0]);
		expect(order.indexOf(BASH_WRITE_SOURCE)).toBeLessThan(
			order.indexOf(BASH_RECOVERY_DRIFT_SOURCE),
		);
		await expect.poll(() => h.calls.drift.length, { timeout: 5000 }).toBe(1);
		expect(h.calls.drift[0]?.paths).toEqual([file]);
	}, 30_000);
});

describe("a publish that reaches no LSP consumer", () => {
	it("records one bounded row per root instead of reading as no held document", () => {
		const root = normalizeMapKey(path.join(tmp, "no-consumer"));
		const first = readHeldDocumentsAnswer(new Map(), root);
		expect(first).toMatchObject({ held: 0, targets: [] });
		const second = readHeldDocumentsAnswer(new Map(), root);
		expect(second).toMatchObject({ held: 0, targets: [] });
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "disk-change-lsp-consumer-missing",
			),
		).toEqual([
			expect.objectContaining({ kind: "disk-change-lsp-consumer-missing" }),
		]);
	});

	it("returns the answer the consumer gave when one exists", () => {
		const answer = {
			held: 3,
			targets: [],
			primary: 0,
			failed: false,
			drained: true,
		};
		expect(
			readHeldDocumentsAnswer(new Map([[LSP_CONSUMER, answer]]), "/x"),
		).toBe(answer);
	});
});
