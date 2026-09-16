/**
 * #3102 member 1: the turn-end late-auxiliary advisory
 * (`runtime-turn:late-auxiliary-findings`) rendered raw LSP findings with no
 * disposition filter, no `.pi-lens.json` rule policy and no inline
 * `pi-lens-ignore` suppression — so a finding the agent marked
 * `false-positive` re-reported on every turn that drained a late pair, while
 * `mode=delta`/`mode=full`/the per-edit dispatcher and (since #3088) the
 * `source=lsp` probe lane all hid it.
 *
 * It also converted with a hardcoded `tool: "lsp"`, so the identity a mark
 * anchors on ("opengrep", the auxiliary's real tool id everywhere else)
 * never matched this surface's rendering (#3046/#3047).
 *
 * Every case drives the PRODUCTION `handleTurnEnd` drain against the real
 * `drainPendingAuxiliaryCoverage` pairs and a real mark written by the
 * production `lens_diagnostic_mark` tool.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());
const observeLateAuxiliaryAnswer = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () =>
		makeLspServiceDouble({
			readCachedDiagnosticsForServers,
			observeLateAuxiliaryAnswer,
		}),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../../clients/cache-manager.js";
import { resetBoundedTelemetry } from "../../../clients/bounded-telemetry.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../../clients/diagnostic-dispositions.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../../clients/runtime-turn.js";
import {
	markPendingAuxiliaryCoverage,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { createLensDiagnosticMarkTool } from "../../../tools/lens-diagnostic-mark.js";
import { removeTempDirSync, setupTestEnvironment } from "../test-utils.js";

const MARKED_MESSAGE = "late finding the agent dismissed";
const OTHER_MESSAGE = "late finding nobody marked";

/** Two lines, so the marked finding's STRICT anchor hashes real content and
 * the unmarked sibling keeps the absence assertion from passing vacuously. */
const FILE_BODY = "const marked = 1;\nconst other = 2;\n";

/** The spelling every OTHER surface renders once `retagAuxiliaryDiagnostics`
 * gives the auxiliary its real tool id — and therefore the spelling of a mark
 * made from the widget, `mode=full` or `mode=delta`. */
const CANONICAL_MARK = { tool: "opengrep", rule: "opengrep:rule-x" };

function diag(line: number, message: string, code = "rule-x"): LSPDiagnostic {
	return {
		range: { start: { line, character: 0 }, end: { line, character: 10 } },
		severity: 2,
		code,
		source: "opengrep",
		message,
	};
}

let env: { tmpDir: string; cleanup: () => void };
let filePath: string;
let previousDataDir: string | undefined;

function makeDeps(runtime: RuntimeCoordinator, cacheManager: CacheManager) {
	return {
		ctxCwd: env.tmpDir,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as never;
}

/** Runs one production turn_end drain over a single late pair carrying
 * `diags`, and returns the advisory text the agent would receive. */
async function drain(diags: LSPDiagnostic[]): Promise<string> {
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: `late-aux-3102-${Date.now()}` });
	runtime.beginTurn();
	const cacheManager = new CacheManager(false);
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		"late-aux-3102",
	);
	markPendingAuxiliaryCoverage(filePath, ["opengrep"], Date.now() - 2000);
	readCachedDiagnosticsForServers.mockImplementation(
		async (_p: string, serverIds: ReadonlySet<string>) => {
			const out = new Map<
				string,
				{ diags: LSPDiagnostic[]; publishedAt: number }
			>();
			if (serverIds.has("opengrep"))
				out.set("opengrep", { diags, publishedAt: Date.now() });
			return out;
		},
	);
	await handleTurnEnd(makeDeps(runtime, cacheManager));
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", env.tmpDir)
			?.data?.content ?? ""
	);
}

async function mark(params: Record<string, unknown>) {
	const markTool = createLensDiagnosticMarkTool(() => env.tmpDir);
	return markTool.execute("mark-3102", params, undefined, () => {}, {
		cwd: env.tmpDir,
	});
}

function lateAuxRecord(): Record<string, any> | undefined {
	return logLatency.mock.calls
		.map((call) => call[0])
		.find(
			(entry: any) =>
				entry?.type === "phase" && entry?.phase === "late_auxiliary_findings",
		);
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-3102-late-aux-");
	filePath = path.join(env.tmpDir, "scanned.ts");
	fs.writeFileSync(filePath, FILE_BODY);
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(filePath, past, past);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	readCachedDiagnosticsForServers.mockReset();
	observeLateAuxiliaryAnswer.mockReset();
	observeLateAuxiliaryAnswer.mockResolvedValue(undefined);
	logLatency.mockClear();
	resetPendingAuxiliaryCoverage();
	resetBoundedTelemetry();
	resetDegradationLedger();
	_resetDeferredForTests();
	_resetStateCacheForTests();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	resetPendingAuxiliaryCoverage();
	resetBoundedTelemetry();
	resetDegradationLedger();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	removeTempDirSync(env.tmpDir);
	env.cleanup();
});

describe("turn-end late-auxiliary advisory applies the finding policy (#3102)", () => {
	it("premise: both findings reach the agent before anything is marked", async () => {
		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).toContain("Late auxiliary diagnostics");
		expect(content).toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a finding marked false-positive under the auxiliary's real tool id", async () => {
		const marked = await mark({
			filePath,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a finding marked from the advisory's own rendering, which prints no tool", async () => {
		// The advisory line is `file:line:col [rule] message` — no tool for the
		// agent to pass on, and `lens_diagnostic_mark`'s `tool` is optional.
		const marked = await mark({
			filePath,
			line: 1,
			message: MARKED_MESSAGE,
			rule: "opengrep:rule-x",
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a rule the project disabled in .pi-lens.json", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens.json"),
			JSON.stringify({ rules: { security: { disable: ["opengrep:rule-x"] } } }),
		);
		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a finding an inline pi-lens-ignore comment suppresses", async () => {
		fs.writeFileSync(
			filePath,
			"// pi-lens-ignore: opengrep:rule-x\nconst marked = 1;\nconst other = 2;\n",
		);
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(filePath, past, past);
		// The comment is line 1; the suppressed finding is on line 2.
		const content = await drain([
			diag(1, MARKED_MESSAGE),
			diag(2, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("honors the auxiliary's own native nosemgrep suppression", async () => {
		fs.writeFileSync(
			filePath,
			"const marked = 1; // nosemgrep: rule-x\nconst other = 2;\n",
		);
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(filePath, past, past);
		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("says nothing at all when every late finding was suppressed", async () => {
		await mark({
			filePath,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const content = await drain([diag(0, MARKED_MESSAGE)]);
		expect(content).not.toContain("Late auxiliary diagnostics");
	});

	it("states the drop count on the delivery and in the bounded turn record", async () => {
		await mark({
			filePath,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const content = await drain([
			diag(0, MARKED_MESSAGE),
			diag(1, OTHER_MESSAGE, "rule-y"),
		]);
		expect(content).toContain("suppressed by disposition: 1 finding(s)");

		const record = lateAuxRecord();
		expect(record).toBeDefined();
		expect(record?.metadata).toMatchObject({
			delivered: 1,
			dispositionSuppressed: 1,
		});
	});

	it("keeps findings visible when the cited file cannot be read (fail open)", async () => {
		await mark({
			filePath,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		// A weak-anchored mark would still apply without content; a STRICT
		// false-positive anchor must not, so an unreadable file leaves the
		// finding VISIBLE rather than hiding it on an I/O error (shape 48).
		// Replace the file with a directory: stat still succeeds (freshness gate
		// passes) while the read fails.
		fs.rmSync(filePath);
		fs.mkdirSync(filePath);
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(filePath, past, past);

		const content = await drain([diag(0, MARKED_MESSAGE)]);
		expect(content).toContain(MARKED_MESSAGE);
	});
});
