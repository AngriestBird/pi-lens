import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveAnalysisRoot,
	canWriteAnalysisRoot,
} from "../../clients/analysis-root.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { syncGitGuardRecord } from "../../clients/git-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

const environments: Array<{ cleanup: () => void }> = [];

afterEach(() => {
	for (const environment of environments.splice(0)) environment.cleanup();
});

describe("analysis-root seam", () => {
	it("classifies session, adopted, and forbidden root inputs", () => {
		const env = setupTestEnvironment("pi-lens-analysis-root-");
		environments.push(env);
		const sessionFile = path.join(env.tmpDir, "src", "file.ts");
		const adoptedFile = path.join(env.tmpDir, "..", "other-project", "file.ts");

		expect(resolveAnalysisRoot(sessionFile, env.tmpDir)).toBe("session");
		expect(resolveAnalysisRoot(adoptedFile, env.tmpDir)).toBe("adopted");
		expect(resolveAnalysisRoot(env.tmpDir, env.tmpDir)).toBe("none");
		expect(canWriteAnalysisRoot("adopted")).toBe(false);
	});

	it("does not write turn-state for an adopted root", () => {
		// Recurrence: #4242 must not let a future adopted-root implementation
		// leak an out-of-session file into workspace-keyed turn state.
		const env = setupTestEnvironment("pi-lens-analysis-root-turn-");
		environments.push(env);
		const cache = new CacheManager();
		cache.addModifiedRange(
			path.join(env.tmpDir, "outside.ts"),
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session",
			"pi",
			undefined,
			"adopted",
		);

		expect(cache.readTurnState(env.tmpDir).files).toEqual({});
		expect(fs.existsSync(path.join(env.tmpDir, ".pi-lens"))).toBe(false);
	});

	it("does not queue deferred format or cascade work for an adopted root", async () => {
		// Recurrence: #4242 keeps adopted roots out of deferred and review/cascade
		// state until the trust and lifecycle slice explicitly admits them.
		const runtime = new RuntimeCoordinator();
		const filePath = path.join(process.cwd(), "outside.ts");

		expect(
			runtime.deferFormat(
				filePath,
				process.cwd(),
				"edit",
				process.cwd(),
				undefined,
				undefined,
				"adopted",
			),
		).toBe(false);
		runtime.appendCascadePromise(
			Promise.resolve({
				filePath,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
			}),
			runtime.captureSessionGeneration(),
			filePath,
			"adopted",
		);

		expect(await runtime.settleCascadeRuns(1)).toEqual({
			settled: 0,
			timedOut: 0,
		});
	});

	it("does not write the git-guard record for an adopted root", () => {
		// Recurrence: #4242 must not persist commit-gate state under an adopted
		// root while adopted analysis remains a no-op.
		const env = setupTestEnvironment("pi-lens-analysis-root-guard-");
		environments.push(env);
		const cache = new CacheManager();
		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(
			path.join(env.tmpDir, "outside.ts"),
			"🔴 STOP\n  blocker",
		);

		cache.writeCache(
			"turn-end-findings",
			{
				content: "test failure",
				hasBlockers: true,
				affectedFiles: [],
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: 0,
				projectSeqEnd: 0,
				fileSeqByPath: {},
				fileContentHashes: {},
				testFailures: true,
				testFailureContent: "test failure",
				testFailureFiles: [],
			},
			env.tmpDir,
		);
		const before = cache.readCache("turn-end-findings", env.tmpDir)?.data;
		syncGitGuardRecord(
			runtime,
			cache,
			env.tmpDir,
			path.join(env.tmpDir, "outside.ts"),
			"adopted",
		);
		expect(cache.readCache("turn-end-findings", env.tmpDir)?.data).toEqual(
			before,
		);
		syncGitGuardRecord(
			runtime,
			cache,
			env.tmpDir,
			path.join(env.tmpDir, "outside.ts"),
			"session",
		);
		expect(cache.inspectCache("turn-end-findings", env.tmpDir)).not.toBe(
			"missing",
		);
	});
});
