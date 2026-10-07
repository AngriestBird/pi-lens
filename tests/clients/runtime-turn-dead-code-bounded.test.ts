/**
 * #4117: the turn_end dead-code scan (vulture) is awaited inside the turn_end
 * hook budget, like knip's (#3872, #3893).
 *
 * Recurrence prevented: `handleTurnEnd` did `await client.analyze(cwd)` outside
 * `bounded()`. A vulture scan of a Python project that takes longer than the
 * 3000 ms `turn_end` budget (measured for this PR: vulture 2.16 on 400 files /
 * 48 000 lines takes 3.3 s, 7.1 s once one linked worktree sits under the root)
 * held the handler for the whole scan, up to vulture's own 30 s timeout, so
 * pi's host loop waited and the late result landed on a turn that had already
 * advanced.
 *
 * Every case drives the real `handleTurnEnd`, the real `PythonDeadCodeClient`
 * and the real `CacheManager`. The one thing faked is the vulture process
 * (`safeSpawnAsync`): the slow scan is a promise the test releases and the
 * budget is spent on a fake clock, so no wall-clock wait and no real spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

const logDeadCodeScan = vi.hoisted(() => vi.fn());
vi.mock("../../clients/dead-code-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dead-code-logger.js")
	>()),
	logDeadCodeScan,
}));

const vultureProcess = vi.hoisted(() => ({
	scans: 0,
	/** When set, the next scan parks on it (the slow scan under test). */
	gate: undefined as Promise<void> | undefined,
	onScan: undefined as (() => void) | undefined,
	/** When set, the scan settles with this error (vulture's own 30 s timeout). */
	failure: undefined as Error | undefined,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(async (_command: string, args: string[]) => {
		if (!args.includes(".")) return { stdout: "", stderr: "", status: 0 };
		vultureProcess.scans += 1;
		vultureProcess.onScan?.();
		await vultureProcess.gate;
		if (vultureProcess.failure) {
			return {
				stdout: "",
				stderr: "",
				status: null,
				error: vultureProcess.failure,
			};
		}
		return {
			stdout: "mod.py:4: unused function 'late' (60% confidence)\n",
			stderr: "",
			status: 3,
		};
	}),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DeadCodeClient,
	type DeadCodeResult,
	PythonDeadCodeClient,
} from "../../clients/dead-code-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const CACHE_KEY = "dead-code-python";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
/** One client per test, as production has one per session: back-off state lives on it. */
let client: PythonDeadCodeClient;
let root: string;

function edit(): void {
	const file = path.join(root, "mod.py");
	fs.writeFileSync(file, "x = 1\n");
	cacheManager.addModifiedRange(file, { start: 1, end: 1 }, false, root);
}

function startTurn(
	signal?: AbortSignal,
	clients: DeadCodeClient[] = [client],
): {
	turn: Promise<void>;
	settled: () => boolean;
} {
	let done = false;
	const turn = handleTurnEnd({
		ctxCwd: root,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		...(signal === undefined ? {} : { signal }),
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: clients,
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps stub
	} as any).then(() => {
		done = true;
	});
	return { turn, settled: () => done };
}

function deadCodeRows(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((entry) => entry.type === "phase" && entry.phase === "dead-code")
		.map((entry) => entry.metadata as Record<string, unknown>);
}

/** Park the scan, begin a turn, and spend the whole turn_end budget on the fake clock. */
async function slowTurn(signal?: AbortSignal) {
	let release!: () => void;
	vultureProcess.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let scan!: () => void;
	const scanning = new Promise<void>((resolve) => {
		scan = resolve;
	});
	vultureProcess.onScan = scan;
	vi.useFakeTimers();
	edit();
	const started = startTurn(signal);
	await scanning;
	await vi.advanceTimersByTimeAsync(3_100);
	return { ...started, release };
}

beforeEach(() => {
	logLatency.mockReset();
	logDeadCodeScan.mockReset();
	resetDegradationLedger();
	vultureProcess.scans = 0;
	vultureProcess.gate = undefined;
	vultureProcess.onScan = undefined;
	vultureProcess.failure = undefined;
	env = setupTestEnvironment("pi-lens-4117-bounded-");
	root = env.tmpDir;
	fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nname="x"\n');
	runtime = new RuntimeCoordinator();
	cacheManager = new CacheManager(false);
	cacheManager.writeCache(
		CACHE_KEY,
		{
			success: true,
			language: "Python",
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "baseline",
		} satisfies DeadCodeResult,
		root,
	);
	client = new PythonDeadCodeClient(false);
});
afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

describe("#4117 turn_end dead-code scan is bounded by the hook budget", () => {
	it("returns inside the budget when the scan outlives it, records the deferral, and writes no late cache row", async () => {
		const slow = await slowTurn();

		// The handler reaches its end with the scan still parked: before #4117 this
		// await never returned until vulture's own 30 s timeout.
		await slow.turn;
		expect(slow.settled()).toBe(true);
		const [row] = deadCodeRows();
		expect(row).toMatchObject({ execution: "deferred", aborted: false });
		expect(String(row?.reason)).toContain("python:deferred");
		const exceeded = getDegradationSummary().find(
			(group) => group.kind === "hook-await-exceeded",
		);
		expect(JSON.stringify(exceeded)).toContain("turn_end:dead-code");

		// The scan settles late: nothing it computes may replace the baseline.
		slow.release();
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		await slow.turn;
		const cached = cacheManager.readCache<DeadCodeResult>(CACHE_KEY, root);
		expect(cached?.data.summary).toBe("baseline");
		expect(cached?.data.unusedExports).toEqual([]);
	});

	it("records an Escape as an abort, not as an exceeded budget", async () => {
		const controller = new AbortController();
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		edit();
		const started = startTurn(controller.signal);
		await scanning;

		controller.abort();
		await started.turn;

		expect(started.settled()).toBe(true);
		expect(deadCodeRows()[0]).toMatchObject({
			execution: "deferred",
			aborted: true,
		});
		expect(
			getDegradationSummary().find((g) => g.kind === "hook-await-exceeded"),
		).toBeUndefined();
		release();
	});

	it("backs off a root whose abandoned scan later timed out, instead of spawning every turn", async () => {
		// #1467's contract: after a timeout, later turns skip rather than launch
		// another 30 s vulture. The back-off used to ride on the cache row the
		// turn wrote when the scan settled INSIDE the turn; an abandoned scan
		// writes none, and a good baseline row is never overwritten by a failure.
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		const slow = await slowTurn();
		await slow.turn;
		// The parked scan finally times out, long after its turn ended.
		slow.release();
		await vi.advanceTimersByTimeAsync(31_000);
		vi.useRealTimers();
		for (let turn = 0; turn < 2; turn++) {
			edit();
			await startTurn().turn;
		}

		expect(vultureProcess.scans).toBe(1);
		const rows = deadCodeRows();
		expect(rows[0]).toMatchObject({ execution: "deferred" });
		for (const row of rows.slice(1)) {
			expect(row).toMatchObject({ skipped: true });
			expect(String(row.reason)).toContain("python:backoff:");
			expect(String(row.reason)).toContain("timed out");
		}
	});

	it("starts no further client once one has outlived the budget", async () => {
		const second = vi.fn(async () => ({
			success: true,
			language: "Other",
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "other",
		}));
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		vi.useFakeTimers();
		edit();
		const started = startTurn(undefined, [
			client,
			{
				id: "other",
				language: "Other",
				detect: () => true,
				owns: () => true,
				ensureAvailable: async () => true,
				analyze: second,
			},
		]);
		await scanning;
		await vi.advanceTimersByTimeAsync(3_100);
		await started.turn;

		expect(second).not.toHaveBeenCalled();
		release();
	});
});

describe("#4117 the scan record names what was left out", () => {
	it("carries the root and the excluded worktree count on the row and the dead-code log", async () => {
		const scripted = {
			id: "python",
			language: "Python",
			detect: () => true,
			owns: () => true,
			ensureAvailable: async () => true,
			analyze: async (): Promise<DeadCodeResult> => ({
				success: true,
				language: "Python",
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
				excludedWorktrees: 2,
			}),
		};
		edit();

		await startTurn(undefined, [scripted]).turn;

		expect(deadCodeRows()[0]).toMatchObject({ excludedWorktrees: 2 });
		expect(logDeadCodeScan).toHaveBeenCalledWith(
			expect.objectContaining({ root, excludedWorktrees: 2 }),
		);
	});
});

describe("#4117 the back-off after an abandoned scan's timeout", () => {
	it("is lifted by the next scan of the root that succeeds", async () => {
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		await client.analyze(root);
		expect(client.recentHardFailure(root)).toContain("timed out");

		vultureProcess.failure = undefined;
		await client.analyze(root);

		expect(client.recentHardFailure(root)).toBeNull();
	});

	it("expires after 30 minutes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		await client.analyze(root);

		vi.setSystemTime(Date.now() + 30 * 60 * 1000 - 1);
		expect(client.recentHardFailure(root)).toContain("timed out");
		vi.setSystemTime(Date.now() + 2);
		expect(client.recentHardFailure(root)).toBeNull();
	});
});
