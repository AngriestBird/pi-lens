/**
 * Tests for per-runner timeoutMs and timer cleanup in runRunner.
 *
 * Covers:
 * - runner.timeoutMs overrides the global 30 s default
 * - a runner that finishes quickly is never cut off
 * - both outcomes (success and throw) complete without hanging
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerGroup, RunnerResult } from "../../../clients/dispatch/types.js";
import {
	getCurrentPhase,
	resetCurrentPhaseForSession,
} from "../../../clients/latency-logger.js";

describe("runRunner timeout behavior", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
	});

	it(
		"fires at runner-level timeoutMs, not the 30 s global default",
		async () => {
			// runner never resolves — only the dispatcher timeout can settle this
			registry.register({
				id: "slow-tool",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 30,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["slow-tool"] },
			]);

			// timed out → no diagnostics, no blockers
			expect(result.diagnostics).toHaveLength(0);
			expect(result.hasBlockers).toBe(false);
		},
		500,
	);

	it("does not cut off a runner that finishes before its timeoutMs", async () => {
		registry.register({
			id: "fast-tool",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return {
					status: "succeeded",
					diagnostics: [
						{
							id: "fast-warn",
							message: "warning from fast-tool",
							filePath: "test.ts",
							severity: "warning",
							semantic: "warning",
							tool: "fast-tool",
						},
					],
					semantic: "warning",
				};
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["fast-tool"] },
		]);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].id).toBe("fast-warn");
	});

	it(
		"returns failed/empty when the runner throws before its timeoutMs",
		async () => {
			registry.register({
				id: "exploding",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					throw new Error("runner blew up");
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["exploding"] },
			]);

			expect(result.diagnostics).toHaveLength(0);
			expect(result.hasBlockers).toBe(false);
		},
	);

	it(
		"slow runner times out while fast runner in the same group still returns its diagnostics",
		async () => {
			// slow-a never resolves — times out at 30 ms
			registry.register({
				id: "slow-a",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 30,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			// fast-b resolves immediately
			registry.register({
				id: "fast-b",
				appliesTo: ["jsts"],
				priority: 11,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "b-warn",
								message: "from fast-b",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "fast-b",
							},
						],
						semantic: "warning",
					};
				},
			});

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				// mode "all" runs both; slow-a times out, fast-b succeeds
				{ mode: "all", runnerIds: ["slow-a", "fast-b"] },
			]);

			expect(result.diagnostics.map((d) => d.id)).toEqual(["b-warn"]);
		},
		500,
	);
});

// #1723: runRunner is the hot dispatch path a synchronous CPU hog (ast-grep,
// tree-sitter) blocks the loop from inside — recentPhases only ever names a
// phase that already FINISHED, so a synchronous block never gets to log its
// own completion before a loop_block sample can see it. Bracketing the runner
// call with phaseStarted/phaseFinished (clients/latency-logger.ts) fixes
// that; these tests pin the bracket's lifecycle at the dispatcher seam.
describe("runRunner in-flight phase attribution (#1723)", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		resetCurrentPhaseForSession();
	});

	it("names the runner as the in-flight phase while its run() is still executing", async () => {
		let observedDuringRun: string | undefined;
		registry.register({
			id: "astgrep-scan",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			async run(): Promise<RunnerResult> {
				// Read the slot mid-flight — this is the synthetic stand-in for a
				// loop_block sample landing while the runner is still running.
				observedDuringRun = getCurrentPhase()?.phase;
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["astgrep-scan"] }]);

		expect(observedDuringRun).toBe("astgrep-scan");
	});

	it("clears the slot once a successful runner returns", async () => {
		registry.register({
			id: "fast-tool",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["fast-tool"] }]);

		expect(getCurrentPhase()).toBeUndefined();
	});

	// The slot must clear on every exit path, not just the happy one — a
	// throwing or timed-out runner is exactly the shape most likely to leave a
	// stale slot if `phaseFinished` weren't in a `finally`.
	it("clears the slot when the runner throws", async () => {
		registry.register({
			id: "exploding",
			appliesTo: ["jsts"],
			priority: 10,
			enabledByDefault: true,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				throw new Error("runner blew up");
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["exploding"] }]);

		expect(getCurrentPhase()).toBeUndefined();
	});

	it(
		"clears the slot when the runner times out",
		async () => {
			registry.register({
				id: "slow-tool",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 30,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			const ctx = createMockContext("test.ts");
			await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["slow-tool"] }]);

			expect(getCurrentPhase()).toBeUndefined();
		},
		500,
	);
});

// #1723 review round: the earlier single-slot design was probe-proven wrong
// against the REAL dispatcher, not just in the abstract. `dispatchForFile`
// runs its runner groups in PARALLEL (`Promise.all`, dispatcher.ts:853) — two
// runners in DIFFERENT groups genuinely overlap; two runners in the SAME
// group run sequentially (runGroup's own for-loop), so this test deliberately
// puts the hog and the idle runner in separate groups.
describe("runRunner in-flight phase attribution against real parallel groups (#1723 review F1/F2)", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		resetCurrentPhaseForSession();
	});

	it(
		"names the CPU hog while an idle runner in a parallel group starts after it and finishes first",
		async () => {
			let hogResolve!: (r: RunnerResult) => void;
			const hogPromise = new Promise<RunnerResult>((resolve) => {
				hogResolve = resolve;
			});

			registry.register({
				id: "cpu-hog",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					return hogPromise;
				},
			});
			registry.register({
				id: "idle",
				appliesTo: ["jsts"],
				priority: 11,
				enabledByDefault: true,
				async run(): Promise<RunnerResult> {
					return { status: "succeeded", diagnostics: [], semantic: "warning" };
				},
			});

			const ctx = createMockContext("test.ts");
			const dispatchPromise = dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["cpu-hog"] },
				{ mode: "all", runnerIds: ["idle"] },
			]);

			// Flush a macrotask so the idle group's whole promise chain (several
			// microtask hops: run() → Promise.race → .finally → phaseFinished)
			// has fully settled, while cpu-hog's run() is still deliberately
			// unresolved.
			await new Promise((resolve) => setTimeout(resolve, 0));

			// F1: a single slot held only the LAST starter — idle, which started
			// AFTER the hog — so it would have named the innocent idle runner.
			// F2: idle finishing FIRST would then have cleared that slot,
			// wiping the hog's attribution while it was still running. The
			// Map-based live set does neither: it still names the hog, the
			// oldest bracket still open.
			expect(getCurrentPhase()?.phase).toBe("cpu-hog");

			hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
			await dispatchPromise;
			expect(getCurrentPhase()).toBeUndefined();
		},
		2_000,
	);
});
