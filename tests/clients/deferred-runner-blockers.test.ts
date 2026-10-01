/**
 * #3814 — the deferred-blocker recording seam, below the host entry.
 *
 * `tests/index-3814-deferred-blocker-gate.test.ts` proves the commit gate
 * through the pi host. This file pins the two properties that entry cannot
 * reach: the recording's provenance contract with the retire seam, and the
 * gate's fail-open behaviour when its pre-check throws. Real
 * `RuntimeCoordinator`, `CacheManager` and pending store throughout.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { absorbSettledRunnerBlockers } from "../../clients/deferred-runner-blockers.js";
import {
	deferRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { Diagnostic, RunnerResult } from "../../clients/dispatch/types.js";
import { evaluateGitGuard } from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

const RUNNER_ID = "slow-runner";

afterEach(() => {
	resetPendingRunnerFindings();
	resetDegradationLedger();
	vi.restoreAllMocks();
});

function blocking(filePath: string): Diagnostic {
	return {
		id: `${RUNNER_ID}:app.ts:1`,
		message: "alpha is not a function",
		filePath,
		line: 1,
		severity: "error",
		semantic: "blocking",
		tool: RUNNER_ID,
		rule: "TS2349",
	};
}

/** A settled deferred answer for `filePath`, scanned just now. */
async function settledAnswer(filePath: string, cwd: string): Promise<void> {
	const result: RunnerResult = {
		status: "succeeded",
		diagnostics: [blocking(filePath)],
		semantic: "blocking",
	};
	deferRunnerFindings({
		filePath,
		cwd,
		projectRoot: cwd,
		runnerId: RUNNER_ID,
		markedAtMs: Date.now(),
		promise: Promise.resolve(result),
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("deferred blocker recording (#3814)", () => {
	it("is retired only by a clean verdict that covers the runner that raised it", async () => {
		// Recurrence: inline blockers carry the `tool` ids behind them so an
		// LSP-only clean cannot retire an eslint/pyright blocker (#1561 F1). A
		// deferred record that dropped `sources` would be retired by any clean
		// verdict, or (fail-closed on unknown provenance) by none.
		const env = setupTestEnvironment("pi-lens-3814-sources-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					"lsp",
				]),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					RUNNER_ID,
				]),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("makes a file blocking again when a deferred blocker joins a fully suppressed record", async () => {
		// Recurrence: `policySuppressed` is a verdict about the OLD finding set
		// (#3248). A merge that kept it would let the gate ignore a live deferred
		// blocker because the agent marked the earlier, different finding.
		const env = setupTestEnvironment("pi-lens-3814-suppressed-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const inline: Diagnostic = {
				...blocking(filePath),
				id: "inline-tool:app.ts:1",
				tool: "inline-tool",
				message: "inline finding",
			};
			runtime.recordInlineBlockers(
				filePath,
				"inline summary",
				runtime.nextWriteIndex(),
				["inline-tool"],
				[1],
				undefined,
				[inline],
			);
			runtime.applyInlineBlockerPolicyVerdicts([filePath]);
			runtime.updateGitGuardStatus(false, "");
			expect(runtime.gitGuardHasBlockers).toBe(false);

			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a record with no structured diagnostics as it was", async () => {
		// Recurrence: merging into a text-only record would replace its text with
		// the new findings alone at the next replay (the replay re-renders from
		// `diagnostics`). The file already blocks, so nothing is lost by waiting.
		const env = setupTestEnvironment("pi-lens-3814-unstructured-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.recordInlineBlockers(
				filePath,
				"legacy summary text",
				runtime.nextWriteIndex(),
				["legacy-tool"],
			);
			await settledAnswer(filePath, env.tmpDir);

			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(0);
			expect(runtime.getInlineBlockersSnapshot()).toMatchObject([
				{ summary: "legacy summary text" },
			]);
			expect(
				runtime.getInlineBlockersSnapshot()[0]?.diagnostics,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("fails open on a pre-check fault and judges the same answer again at the next attempt", async () => {
		// Recurrence (r1 L2): the gate claimed every settled entry before judging
		// any, so one transient fault left the entry unjudged for the rest of the
		// session and the next commit passed on a blocker that was waiting. The
		// fault is one counted ledger row; the retry blocks.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			await settledAnswer(filePath, env.tmpDir);
			vi.spyOn(runtime, "recordDeferredInlineBlockers").mockImplementationOnce(
				() => {
					throw new Error("injected recording fault");
				},
			);

			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				false,
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "deferred-blocker-gate-error",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.reason).toContain(
				"injected recording fault",
			);
			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				true,
			);
		} finally {
			env.cleanup();
		}
	});

	it("stamps the record with the moment the runner scanned", async () => {
		// Recurrence (r1 L3): `recordedAtMs` is the baseline the dependency-drift
		// sweep compares file and import mtimes against; a record stamped 0 is
		// demoted at the first sweep, and stamped with the recording time it would
		// never see a drift that happened between the scan and the recording.
		const env = setupTestEnvironment("pi-lens-3814-stamp-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const markedAtMs = Date.now() + 10_000;
			deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: RUNNER_ID,
				markedAtMs,
				promise: Promise.resolve({
					status: "succeeded",
					diagnostics: [blocking(filePath)],
					semantic: "blocking",
				} satisfies RunnerResult),
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.getInlineBlockersSnapshot()[0]?.recordedAtMs).toBe(
				markedAtMs,
			);
		} finally {
			env.cleanup();
		}
	});
});
