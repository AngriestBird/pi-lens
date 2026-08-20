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
	getPhaseForWindow,
	type PhaseWindowAttribution,
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

	// #1723 review round 3, N1 (blocker): the reviewer flipped ONLY the
	// dispatch group order (idle-first vs. hog-first) and got "innocent-idle"
	// again — the round-2 tie-break fell back to scan/insertion order on an
	// overlap tie, which is not a real signal. This runs the SAME scenario in
	// BOTH group orders and asserts via `getPhaseForWindow` — the actual
	// production read path (`index.ts`'s `turn_end`, not the test-only
	// `getCurrentPhase` seam) — so the fix is proven at the call site
	// `turn_end` really uses.
	async function runParallelHogAndIdle(
		groupOrder: readonly ["cpu-hog", "idle"] | readonly ["idle", "cpu-hog"],
	): Promise<{
		duringHog: PhaseWindowAttribution | undefined;
		afterHog: PhaseWindowAttribution | undefined;
	}> {
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
		const dispatchStartMs = Date.now();
		const dispatchPromise = dispatchForFile(
			ctx,
			groupOrder.map((runnerId) => ({ mode: "all" as const, runnerIds: [runnerId] })),
		);

		// Flush a REAL macrotask (50ms, not 0) so the idle group's whole
		// promise chain (run() → Promise.race → .finally → phaseFinished) has
		// fully settled and cpu-hog's own elapsedMs clears the N4 plausibility
		// floor, while cpu-hog's run() is still deliberately unresolved.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const sampledAtMs = Date.now();
		const duringHog = getPhaseForWindow(dispatchStartMs, sampledAtMs);

		hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
		await dispatchPromise;
		const afterHog = getPhaseForWindow(dispatchStartMs, Date.now());

		return { duringHog, afterHog };
	}

	it(
		"names the CPU hog via getPhaseForWindow when the hog's group is listed first",
		async () => {
			const { duringHog, afterHog } = await runParallelHogAndIdle(["cpu-hog", "idle"]);
			expect(duringHog?.phase).toBe("cpu-hog");
			expect(duringHog?.stillRunning).toBe(true);
			// Once the hog also finishes, it is still the right answer — now as
			// a CLOSED bracket rather than a live one (the closed-ring half of
			// getPhaseForWindow, not just the live-map half).
			expect(afterHog?.phase).toBe("cpu-hog");
			expect(afterHog?.stillRunning).toBe(false);
		},
		2_000,
	);

	it(
		"names the CPU hog via getPhaseForWindow when the IDLE runner's group is listed first (flipped order)",
		async () => {
			const { duringHog, afterHog } = await runParallelHogAndIdle(["idle", "cpu-hog"]);
			expect(duringHog?.phase).toBe("cpu-hog");
			expect(duringHog?.stillRunning).toBe(true);
			expect(afterHog?.phase).toBe("cpu-hog");
			expect(afterHog?.stillRunning).toBe(false);
		},
		2_000,
	);

	it(
		"getCurrentPhase (test seam) agrees with getPhaseForWindow while the hog is still live",
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
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(getCurrentPhase()?.phase).toBe("cpu-hog");

			hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
			await dispatchPromise;
			expect(getCurrentPhase()).toBeUndefined();
		},
		2_000,
	);

	// #1723 review round 4, N1 (E1-real): the LOAD-BEARING dispatcher-level
	// reproduction. Round 3's flipped-order tests above never actually
	// exercised the N1-resid failure mode — by the time either sample ran,
	// nothing else was still LIVE to compete with the (already closed) hog.
	// This runs a genuinely-live "innocent" runner ALONGSIDE the hog — parked
	// on a promise this test deliberately never resolves during the
	// assertion — so when the hog closes and `getPhaseForWindow` samples
	// shortly after (a REAL macrotask flush, not a hand-tuned tie), there is
	// an actual live bracket whose raw overlap is capped at the window's own
	// full length, competing against a just-closed culprit whose raw overlap
	// is always a little short of that. Round 3's code named the innocent
	// runner here; the fraction-ranked fix must name the hog.
	it(
		"E1-real: getPhaseForWindow names the hog over a still-live innocent runner sampled shortly after the hog's own finally",
		async () => {
			let hogResolve!: (r: RunnerResult) => void;
			const hogPromise = new Promise<RunnerResult>((resolve) => {
				hogResolve = resolve;
			});
			let innocentResolve!: (r: RunnerResult) => void;
			const innocentPromise = new Promise<RunnerResult>((resolve) => {
				innocentResolve = resolve; // deliberately NOT resolved until cleanup
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
				id: "innocent-parked-runner",
				appliesTo: ["jsts"],
				priority: 11,
				enabledByDefault: true,
				timeoutMs: 5_000,
				async run(): Promise<RunnerResult> {
					return innocentPromise;
				},
			});

			const ctx = createMockContext("test.ts");
			const dispatchStartMs = Date.now();
			// Fire both groups in parallel; do NOT await this promise — the
			// innocent runner's group never resolves during the assertion
			// window, so dispatchForFile's own Promise.all would hang forever.
			const dispatchPromise = dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["innocent-parked-runner"] },
				{ mode: "all", runnerIds: ["cpu-hog"] },
			]);

			// Let both groups' phaseStarted calls land, then let the hog run for
			// a real (short) duration before resolving it.
			await new Promise((resolve) => setTimeout(resolve, 50));
			hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });

			// Real, unforced sampling lag after the hog's own runRunner
			// `finally` (phaseFinished) — the exact shape of the bug: never
			// zero, and the innocent runner is still genuinely live throughout.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const sampledAtMs = Date.now();

			const attribution = getPhaseForWindow(dispatchStartMs, sampledAtMs);
			expect(attribution?.phase).toBe("cpu-hog");
			expect(attribution?.stillRunning).toBe(false);

			innocentResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
			await dispatchPromise;
		},
		2_000,
	);
});
