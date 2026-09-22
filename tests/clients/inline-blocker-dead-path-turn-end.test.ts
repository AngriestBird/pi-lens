/**
 * Turn-end delivery of the deleted-path-gated inline-blocker record (#3190).
 *
 * #2028's deleted-path gate retracts a blocker whose cited file no longer
 * exists from the per-edit tool result, but PR #3189 left the turn-end record
 * (`inlineBlockerSummary`) built from the UNGATED dispatcher text, so the
 * retracted finding re-surfaced at turn end as an authoritative
 * "Unresolved from this turn" blocker. This drives the real `runPipeline`
 * (mocked dispatcher, real deleted-path gate), applies the same
 * record-or-clear store decision `handleToolResult` makes, and then drives the
 * real `handleTurnEnd` to assert what the agent actually sees:
 *
 *   1. A blocker whose cited file was deleted does NOT reach the turn-end
 *      blocker tier when a surviving blocker shares the record.
 *   2. Total retraction records nothing at all — no "Unresolved from this
 *      turn" section is composed.
 *   3. Partial retraction still re-surfaces the surviving blocker.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

// Real runPipeline; only the dispatcher seam is mocked. The factory spreads
// the original module (#2281 whole-module ratchet: a partial object-literal
// factory silently drops newly added production exports) and overrides just
// the two seams the pipeline consumes.
vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/dispatch/integration.js")
		>();
	return {
		...actual,
		dispatchLintWithResult: vi.fn(),
		computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
	};
});

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { runPipeline } from "../../clients/pipeline.js";
import type { PipelineContext, PipelineDeps } from "../../clients/pipeline.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { _resetSharedLineCountCacheForTests } from "../../clients/diagnostic-line-freshness.js";
import { getFormatService } from "../../clients/format-service.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
}));

import { getLSPService } from "../../clients/lsp/index.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	ctxCwd: string,
) {
	return {
		ctxCwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

function readTurnEndContent(cacheManager: CacheManager, cwd: string): string {
	const findings = cacheManager.readCache<{ content: string }>(
		"turn-end-findings",
		cwd,
	);
	return findings?.data?.content ?? "";
}

function mockDispatch(blockers: unknown[], blockerOutput: string): void {
	vi.mocked(dispatchLintWithResult).mockResolvedValue({
		diagnostics: [],
		blockers: blockers as never,
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: blockerOutput,
		blockerOutput,
		hasBlockers: blockers.length > 0,
	});
}

function blocker(
	id: string,
	filePath: string,
	message: string,
	tool: string,
): Record<string, unknown> {
	return {
		id,
		message,
		filePath,
		line: 1,
		severity: "error",
		semantic: "blocking",
		tool,
	};
}

afterEach(() => {
	cancelLSPIdleReset();
	vi.mocked(dispatchLintWithResult).mockReset();
	_resetSharedLineCountCacheForTests();
	resetDegradationLedger();
});

describe("turn-end delivery of the deleted-path-gated inline-blocker record (#3190)", () => {
	// `recordInlineBlockers` is runtime-tool-result.ts's entire store decision:
	// a summary records the entry, an absent summary clears the file's pending
	// one. Reproducing those two branches here keeps the test on the real
	// producer (runPipeline) and the real consumer (handleTurnEnd).
	function applyToolResultStoreDecision(
		runtime: RuntimeCoordinator,
		filePath: string,
		result: Awaited<ReturnType<typeof runPipeline>>,
	): void {
		if (result.inlineBlockerSummary) {
			runtime.recordInlineBlockers(
				filePath,
				result.inlineBlockerSummary,
				1,
				result.inlineBlockerSources,
				result.inlineBlockerLines,
				result.inlineBlockerFileContent,
			);
		} else {
			runtime.clearInlineBlockers(filePath);
		}
	}

	function makePipelineCtx(filePath: string, cwd: string): PipelineContext {
		return {
			filePath,
			cwd,
			toolName: "edit",
			getFlag: () => false,
			dbg: () => {},
		};
	}

	function makePipelineDeps(): PipelineDeps {
		return {
			biomeClient: {
				isSupportedFile: () => true,
				ensureAvailable: async () => false,
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as PipelineDeps["biomeClient"],
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as PipelineDeps["ruffClient"],
			metricsClient: {} as unknown as PipelineDeps["metricsClient"],
			getFormatService: () => getFormatService("3190-session", false),
			fixedThisTurn: new Set(),
		} as PipelineDeps;
	}

	it("does not re-serve a retracted blocker at turn end when a surviving blocker shares the record", async () => {
		const env = setupTestEnvironment("pi-lens-3190-turnend-partial-");
		try {
			resetDegradationLedger();
			const cwd = env.tmpDir;
			const liveFile = path.join(cwd, "record-live.ts");
			fs.writeFileSync(liveFile, "const x = 1;\nconst y = 2;\n");
			const deletedFile = path.join(cwd, "record-deleted.ts");

			const mockLSPService = makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
			});
			vi.mocked(getLSPService).mockReturnValue(mockLSPService as never);
			mockDispatch(
				[
					blocker(
						"dead-1",
						deletedFile,
						"DEAD-PATH-BLOCKER-MARKER secret in removed file",
						"gitleaks",
					),
					blocker(
						"live-1",
						liveFile,
						"LIVE-FILE-BLOCKER-MARKER unused var",
						"ruff",
					),
				],
				"DEAD-PATH-BLOCKER-MARKER secret in removed file\nLIVE-FILE-BLOCKER-MARKER unused var\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = cwd;
			runtime.setTelemetryIdentity({ sessionId: "3190-partial" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				liveFile,
				{ start: 1, end: 1 },
				false,
				cwd,
				"3190-partial",
			);

			const result = await runPipeline(
				makePipelineCtx(liveFile, cwd),
				makePipelineDeps(),
			);
			applyToolResultStoreDecision(runtime, liveFile, result);

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const content = readTurnEndContent(cacheManager, cwd);
			// The surviving blocker still re-surfaces at full authority…
			expect(content).toContain("Unresolved from this turn");
			expect(content).toContain("LIVE-FILE-BLOCKER-MARKER");
			// …the blocker the deleted-path gate retracted from the tool result
			// does not come back at turn end.
			expect(content).not.toContain("DEAD-PATH-BLOCKER-MARKER");
		} finally {
			env.cleanup();
		}
	});

	it("records nothing at turn end when every blocker cites a deleted file", async () => {
		const env = setupTestEnvironment("pi-lens-3190-turnend-total-");
		try {
			resetDegradationLedger();
			const cwd = env.tmpDir;
			// The record's KEY (this file) still exists, so the turn-end
			// reconcile would keep an entry — the producer must not record one.
			const liveFile = path.join(cwd, "record-target.ts");
			fs.writeFileSync(liveFile, "const x = 1;\n");
			const deletedFile = path.join(cwd, "record-also-deleted.ts");

			const mockLSPService = makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
			});
			vi.mocked(getLSPService).mockReturnValue(mockLSPService as never);
			mockDispatch(
				[
					blocker(
						"dead-2",
						deletedFile,
						"GHOST-BLOCKER-MARKER finding in removed file",
						"gitleaks",
					),
				],
				"GHOST-BLOCKER-MARKER finding in removed file\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = cwd;
			runtime.setTelemetryIdentity({ sessionId: "3190-total" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				liveFile,
				{ start: 1, end: 1 },
				false,
				cwd,
				"3190-total",
			);

			const result = await runPipeline(
				makePipelineCtx(liveFile, cwd),
				makePipelineDeps(),
			);
			applyToolResultStoreDecision(runtime, liveFile, result);

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const content = readTurnEndContent(cacheManager, cwd);
			// Total retraction leaves nothing for the turn-end blocker tier to
			// say — in particular not a re-assertion of the retracted finding.
			expect(content).not.toContain("Unresolved from this turn");
			expect(content).not.toContain("GHOST-BLOCKER-MARKER");
		} finally {
			env.cleanup();
		}
	});
});
