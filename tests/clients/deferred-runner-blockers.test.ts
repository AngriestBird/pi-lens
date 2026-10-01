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

	it("fails open and counts once when the gate's pre-check throws", async () => {
		// Recurrence: the pre-check is new code on the commit path; a throw out of
		// it must not turn every commit into a host error. The pre-#3814 answer
		// stands and the fault is one counted ledger row.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			await settledAnswer(filePath, env.tmpDir);
			vi.spyOn(runtime, "recordDeferredInlineBlockers").mockImplementation(
				() => {
					throw new Error("injected recording fault");
				},
			);

			for (let attempt = 0; attempt < 2; attempt++) {
				expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
					false,
				);
			}
			const row = getDegradationSummary().find(
				(group) => group.kind === "deferred-blocker-gate-error",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.reason).toContain(
				"injected recording fault",
			);
		} finally {
			env.cleanup();
		}
	});
});
