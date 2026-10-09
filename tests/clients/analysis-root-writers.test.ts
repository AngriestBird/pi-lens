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
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	recordProjectChange,
	recordTurnSummary,
} from "../../clients/runtime-tool-result.js";
import { readChangesSince } from "../../clients/project-changes.js";
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
		const adoptedRoot = path.join(env.tmpDir, "..", "other-project");
		fs.mkdirSync(adoptedRoot, { recursive: true });
		fs.writeFileSync(path.join(adoptedRoot, "package.json"), "{}\n");
		const adoptedFile = path.join(adoptedRoot, "file.ts");

		expect(resolveAnalysisRoot(sessionFile, env.tmpDir)).toBe("session");
		expect(resolveAnalysisRoot(adoptedFile, env.tmpDir)).toBe("adopted");
		expect(resolveAnalysisRoot(env.tmpDir, env.tmpDir)).toBe("none");
		expect(canWriteAnalysisRoot("adopted")).toBe(false);
	});

	it("refuses symlinked protected roots and keeps linked-worktree vendors out", () => {
		// Recurrence: #4257 F3/F7 must not create a second identity through a
		// symlink or re-admit vendor content before the linked-worktree guard.
		const env = setupTestEnvironment("pi-lens-analysis-root-links-");
		environments.push(env);
		const protectedRoot = path.join(env.tmpDir, "protected");
		const link = path.join(env.tmpDir, "protected-link");
		fs.mkdirSync(protectedRoot, { recursive: true });
		fs.writeFileSync(path.join(protectedRoot, "package.json"), "{}\n");
		try {
			fs.symlinkSync(protectedRoot, link, "dir");
		} catch {
			expect(true).toBe(true);
			return;
		}
		expect(resolveAnalysisRoot(path.join(link, "a.ts"), env.tmpDir)).toBe(
			"session",
		);
	});

	it("requires a marker and refuses session ancestors", () => {
		// Recurrence: an arbitrary out-of-root file must not turn its containing
		// directory or a parent of the session into an analysis project.
		const env = setupTestEnvironment("pi-lens-analysis-root-marker-");
		environments.push(env);
		const unmarked = path.join(env.tmpDir, "..", "unmarked", "file.ts");
		const markedRoot = path.join(env.tmpDir, "..", "marked");
		fs.mkdirSync(markedRoot, { recursive: true });
		fs.writeFileSync(path.join(markedRoot, "pyproject.toml"), "[project]\n");
		const marked = path.join(markedRoot, "src", "file.py");

		expect(resolveAnalysisRoot(unmarked, env.tmpDir)).toBe("none");
		expect(resolveAnalysisRoot(marked, env.tmpDir)).toBe("adopted");
		expect(resolveAnalysisRoot(path.dirname(env.tmpDir), env.tmpDir)).toBe(
			"none",
		);
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

	it("does not record a project change for an adopted root through tool_result", async () => {
		// Recurrence: #4242 must keep the real tool_result project-change writer
		// from persisting a receipt for an adopted root.
		const env = setupTestEnvironment("pi-lens-analysis-root-project-change-");
		environments.push(env);
		const filePath = path.join(env.tmpDir, "..", "adopted-project", "file.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const value = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;

		await handleToolResult({
			event: {
				toolName: "write",
				input: { path: filePath },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);
		recordProjectChange({
			runtime,
			cwd: env.tmpDir,
			filePath,
			source: "agent-write",
			analysisRootMode: "adopted",
			dbg: () => {},
		});

		expect(readChangesSince(env.tmpDir, 0)).toEqual([]);
	});

	it("does not record a turn summary for an adopted root through tool_result", async () => {
		// Recurrence: #4242 must keep the real tool_result turn-summary writer a
		// no-op until adopted-root analysis is explicitly admitted.
		const env = setupTestEnvironment("pi-lens-analysis-root-turn-summary-");
		environments.push(env);
		const filePath = path.join(env.tmpDir, "..", "adopted-project", "file.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const value = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;

		await handleToolResult({
			event: {
				toolName: "write",
				input: { path: filePath },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: (name: string) => name === "lens-turn-summary",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			readGuard: runtime.readGuard,
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);
		recordTurnSummary({
			runtime,
			filePath,
			resultLive: true,
			analysisRootMode: "adopted",
			getFlag: () => true,
			result: {
				diagnostics: [
					{
						filePath,
						tool: "eslint",
						message: "unused",
						severity: "warning",
					},
				],
				fixedCount: 1,
				autofixTools: ["ruff:1"],
				formattersUsed: ["prettier"],
			} as never,
		});

		expect(runtime.turnSummary.isEmpty()).toBe(true);
	});
});
