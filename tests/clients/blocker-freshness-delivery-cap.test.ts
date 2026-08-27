/**
 * Turn-end integration for the dependency-drift delivery cap (#1950).
 *
 * #1631's freshness gate demotes a blocker whose dependency drifted to a
 * `[stale — re-run to confirm]` advisory (demote, not drop — #1419), and
 * #1949 gave that demotion the shared degradation-ledger body, but
 * deliberately did NOT retire it: the cited coordinates are still in bounds,
 * so a fresh dispatch can genuinely confirm or clear it. Nothing capped how
 * many times the SAME demoted record kept re-serving, though — incident data
 * showed 18 `alreadyStale` re-serves in one window with near-zero
 * information after the first delivery.
 *
 * This drives the real `handleTurnEnd` across several turns and asserts:
 *   1. The demotion re-serves, unretired, below the delivery cap.
 *   2. At the cap (`DEPENDENCY_DRIFT_MAX_DELIVERIES`), the record retires
 *      with a note that says the OPPOSITE of #1944's past-EOF retirement —
 *      "re-run can still confirm", not "cannot be re-confirmed".
 *   3. After retirement, the record is gone from the store and never
 *      resurfaces.
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

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { DEPENDENCY_DRIFT_MAX_DELIVERIES } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
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

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
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
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", cwd)?.data
			?.content ?? ""
	);
}

/** Drive one more turn with activity so `handleTurnEnd` doesn't early-return
 * on "no modified files this turn" (same requirement blocker-past-eof-turn-end
 * uses for its multi-turn case). */
function driveTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	consumer: string,
	cwd: string,
	sessionId: string,
): Promise<void> {
	runtime.beginTurn();
	runtime.bumpFileSeq(consumer);
	cacheManager.addModifiedRange(
		consumer,
		{ start: 1, end: 2 },
		false,
		cwd,
		sessionId,
	);
	return handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	logLatency.mockClear();
});

describe("dependency-drift delivery cap (#1950)", () => {
	it(`retires after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries, with a "still confirmable" note, not #1944's "unrecoverable" one`, async () => {
		const env = setupTestEnvironment("pi-lens-1950-cap-");
		try {
			const sessionId = "cap-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);

			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(consumer, "🔴 L1 a real blocker", 1, [
				"lsp",
			]);

			// The dependency drifts out-of-band after the verdict.
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			// Turn 1: the sweep detects drift and demotes; the SAME turn's
			// delivery loop serves the fresh demotion (delivery 1 of the cap).
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			let content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).not.toContain("Not shown again after");
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);

			// Turns 2..cap-1: re-served, still not retired.
			for (
				let delivery = 2;
				delivery < DEPENDENCY_DRIFT_MAX_DELIVERIES;
				delivery++
			) {
				await driveTurn(runtime, cacheManager, consumer, env.tmpDir, sessionId);
				content = readTurnEndContent(cacheManager, env.tmpDir);
				expect(content).toContain("[stale — re-run to confirm]");
				expect(content).not.toContain("Not shown again after");
				expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			}

			// The delivery that reaches the cap retires the record.
			await driveTurn(runtime, cacheManager, consumer, env.tmpDir, sessionId);
			content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).toContain(
				`Not shown again after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries`,
			);
			// #1950 vs #1944: the wording must NOT claim the finding is
			// unconfirmable — it may still be accurate.
			expect(content).not.toContain("cannot be re-confirmed");
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "demoted-finding-retired",
						latestReasons: expect.arrayContaining([
							expect.objectContaining({
								reason: expect.stringContaining("re-run can still confirm"),
							}),
						]),
					}),
				]),
			);

			// A further turn has nothing left to re-serve: the record never
			// resurfaces once retired (proven directly against the store rather
			// than the cache, since an empty turn-end result may leave the prior
			// cache entry untouched — a caching detail orthogonal to this fix).
			await driveTurn(runtime, cacheManager, consumer, env.tmpDir, sessionId);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
