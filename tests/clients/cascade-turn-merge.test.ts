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
