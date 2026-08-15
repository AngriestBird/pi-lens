import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { CascadeResult } from "../../clients/cascade-types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function diagnostic(filePath: string, message: string, line = 1): Diagnostic {
	return {
		id: `lsp:test:${line}`,
		message,
		filePath,
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
}

function cascade(
	primary: string,
	neighbor: string,
	message: string,
): CascadeResult {
	const neighborBase = path.basename(neighbor);
	return {
		filePath: primary,
		impact: {
			filePath: primary,
			changedSymbols: [],
			directImporters: [neighbor],
			directCallers: [],
			neighborFiles: [neighbor],
			riskFlags: [],
		},
		neighbors: [
			{
				filePath: neighbor,
				reason: "imports",
				diagnostics: [diagnostic(neighbor, message)],
				lspTouched: false,
			},
		],
		formatted: `Cascade errors in 1 dependent file\n${neighborBase}: ${message}`,
	};
}

describe("cascade turn-end merge", () => {
	it("deduplicates cascade diagnostics by neighbor file with last writer winning", async () => {
		const env = setupTestEnvironment("cascade-turn-merge-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primaryA = path.join(env.tmpDir, "a.ts");
			const primaryB = path.join(env.tmpDir, "b.ts");
			const sharedNeighbor = path.join(env.tmpDir, "shared.ts");
			fs.writeFileSync(primaryA, "export const a = 1;\n");
			fs.writeFileSync(primaryB, "export const b = 1;\n");
			fs.writeFileSync(sharedNeighbor, "export const shared = 1;\n");

			cacheManager.addModifiedRange(
				primaryA,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.addModifiedRange(
				primaryB,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primaryA,
				result: cascade(primaryA, sharedNeighbor, "old error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});
			runtime.appendCascadeRun({
				filePath: primaryB,
				result: cascade(primaryB, sharedNeighbor, "new error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade errors in 1 dependent file");
			expect(content).toContain("shared.ts");
			expect(content).toContain("new error");
			expect(content).not.toContain("old error");
		} finally {
			env.cleanup();
		}
	});

	// #1443: a high-fan-out cascade compute that misses the turn-end settle cap is
	// re-parked by `settleCascadeRuns` for the NEXT turn_end — and used to be
	// discarded there, because the origin filter demanded `originTurn ===
	// turnIndex` and a late run is by definition from an earlier turn. `projectSeq`
	// (unchanged here — no later write) is the actual supersede signal.
	it("merges a compute that resolved after the settle cap on the following turn_end (#1443)", async () => {
		const env = setupTestEnvironment("cascade-late-settle-");
		// Keep the settle cap short — this test is about what happens AFTER it
		// lapses, not about the 5s default.
		const prevSettleWait = process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
		process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = "0";
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "logger.ts");
			const neighbor = path.join(env.tmpDir, "consumer.ts");
			fs.writeFileSync(primary, "export const log = 1;\n");
			fs.writeFileSync(neighbor, "import { log } from './logger';\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			const turnEnd = async () =>
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);

			// Turn 1: the 38-neighbour compute is still running at the cap.
			runtime.beginTurn();
			let release!: (r: import("../../clients/cascade-types.js").CascadeRun) => void;
			runtime.appendCascadePromise(
				new Promise((res) => {
					release = res;
				}),
			);
			await turnEnd();
			consumeTurnEndFindings(cacheManager, env.tmpDir);

			// It lands moments later, stamped with the turn that launched it.
			release({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: runtime.projectSeq },
				result: cascade(primary, neighbor, "late high-fanout error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			// Turn 2: no write superseded it, so it must be merged, not discarded.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ??
				"";
			expect(content).toContain("consumer.ts");
			expect(content).toContain("late high-fanout error");
		} finally {
			if (prevSettleWait === undefined) {
				delete process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
			} else {
				process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = prevSettleWait;
			}
			env.cleanup();
		}
	});

	// #1443/#1444 END TO END: a native-TS7 neighbour's diagnostics arrive by pull
	// AFTER the cascade touch budget, so the quiet-window reconcile appends its
	// CascadeRun only once the turn that launched it has already consumed its
	// runs. The finding must therefore surface in the FOLLOWING turn_end.
	// Pre-fix, `beginTurn` wiped `_cascadeRuns` at turn_start and the run was
	// deleted one step before the message that would have carried it — computed,
	// formatted, appended, and silently dropped.
	it("surfaces a late native-TS7 neighbour error in the FOLLOWING turn_end (#1443)", async () => {
		const env = setupTestEnvironment("cascade-carry-over-");
		const {
			_resetOutstandingCascadeTouchesForTests,
			recordOutstandingCascadeTouch,
			reconcileOutstandingCascadeTouches,
		} = await import("../../clients/lsp/cascade-tier.js");
		const { buildResolvedFoundCascadeRun } = await import(
			"../../clients/cascade-format.js"
		);
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		_resetOutstandingCascadeTouchesForTests();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "primary.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			const later = path.join(env.tmpDir, "later.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			fs.writeFileSync(later, "export const y = 2;\n");

			const turnEnd = async () =>
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);

			// --- Turn 1: the edit that launched the cascade. Its native-TS7
			// neighbour touch skipped the in-lane wait, so turn_end says nothing.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			expect(
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ??
					"",
			).not.toContain("neighbor.ts");

			// --- Quiet window after turn 1: the pull result finally lands.
			const touchedAt = Date.now() - 50;
			recordOutstandingCascadeTouch({
				filePath: neighbor,
				serverId: "typescript",
				touchedAt,
			});
			const outcomes = await reconcileOutstandingCascadeTouches({
				getWarmClientForFile: async () => ({
					client: {
						serverId: "typescript",
						getAllDiagnostics: () =>
							new Map([
								[
									normalizeMapKey(neighbor),
									{
										ts: Date.now(),
										diags: [
											{
												severity: 1,
												message: "late native TS7 error",
												range: {
													start: { line: 0, character: 0 },
													end: { line: 0, character: 1 },
												},
											},
										],
									},
								],
							]),
					},
				}),
			} as any);
			expect(outcomes[0]?.outcome).toBe("resolved-found");
			const run = buildResolvedFoundCascadeRun(env.tmpDir, {
				filePath: neighbor,
				diagnostics: outcomes[0]?.diagnostics ?? [],
			});
			expect(run).toBeDefined();
			// This is exactly what index.ts's onResolvedFound callback does.
			if (run) runtime.appendCascadeRun(run);

			// --- Turn 2: a new turn_start (which used to wipe the run) and a new
			// edit. The carried finding must reach the agent here.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				later,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ??
				"";
			expect(content).toContain("neighbor.ts");
			expect(content).toContain("late native TS7 error");

			// --- Turn 3: consumed once, never replayed.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				later,
				{ start: 2, end: 2 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			expect(
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ??
					"",
			).not.toContain("late native TS7 error");
		} finally {
			_resetOutstandingCascadeTouchesForTests();
			env.cleanup();
		}
	});

	// #1023: a degraded/indeterminate cascade run must surface an HONEST note at
	// turn_end (today it was a silent all-clear — the #533 bug). It lands in the
	// ADVISORY tier (not the blocker tier) so an over-cap monorepo does not fire a
	// hard blocker every turn. Keyed off the `indeterminate` marker on the run.
	it("surfaces an indeterminate advisory when a cascade run could not compute impact", async () => {
		const env = setupTestEnvironment("cascade-indeterminate-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "over-cap.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "graph_degraded",
					detail: "review graph disabled — 5000 files over the 4000 cap",
					sourceFileCount: 5000,
					maxFileCount: 4000,
				},
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade could not compute downstream impact");
			expect(content).toContain("a clean cascade result does not cover them");
			expect(content).toContain("over-cap.ts");
			expect(content).toContain("5000 files over the 4000 cap");
			// Advisory tier, not blocker tier: it carries the advisory label and
			// must NOT read as a hard blocker imperative.
			expect(content).toContain("Advisory — no action required this turn");
			expect(content).not.toContain("review dependents manually");
		} finally {
			env.cleanup();
		}
	});

	// #1104 (review P3 on PR #1143): the advisory preamble used to hardcode "the
	// review graph was unavailable" for EVERY indeterminate reason. For
	// `lsp_binding_rejected` that's a mis-attribution — the graph WAS available
	// and dependents WERE derived; only the LSP diagnostics display was
	// withheld because a fallback snapshot's content binding didn't match
	// current disk. The advisory must use a reason-appropriate frame instead.
	it("uses a binding-specific frame (not 'review graph was unavailable') for an lsp_binding_rejected run", async () => {
		const env = setupTestEnvironment("cascade-binding-rejected-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "edited.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "lsp_binding_rejected",
					detail:
						"cascade fallback diagnostics were withheld — stale snapshot content did not match current disk (binding rejected)",
				},
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			// HEADLINE (fails pre-#1104): the old hardcoded frame mis-attributed
			// the cause to the review graph for every reason, including this one.
			expect(content).not.toContain("the review graph was unavailable");
			expect(content).toContain("edited.ts");
			expect(content).toContain("binding rejected");
			expect(content).toContain("Advisory — no action required this turn");
		} finally {
			env.cleanup();
		}
	});

	// #1023 over-correction guard: a HEALTHY run that genuinely found no
	// dependents (skipReason "no_neighbors", no indeterminate marker) must NOT
	// emit the advisory — a real clean leaf edit stays silent (no crying wolf).
	it("stays silent for a healthy no_neighbors run (no over-correction)", async () => {
		const env = setupTestEnvironment("cascade-clean-leaf-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "leaf.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "no_neighbors",
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).not.toContain("Cascade could not compute downstream impact");
		} finally {
			env.cleanup();
		}
	});
});
