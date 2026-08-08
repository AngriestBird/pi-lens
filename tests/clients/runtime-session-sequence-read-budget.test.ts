/**
 * Regression tests for #1162 — `session_start_sequence_read` was a
 * synchronous, UNBOUNDED blocking read (`fs.readFileSync`) on the
 * session_start critical path. Normally ~2ms, but under host I/O pressure it
 * balloons with no escape hatch (2125ms observed in production latency.log).
 *
 * A `setTimeout`/`Promise.race` timeout can never preempt a *synchronous*
 * read — the thread only returns to the event loop once the OS call
 * returns — so the fix switches the read to `fs.promises.readFile`
 * (`readLatestProjectSequenceAsync`), which genuinely yields, and races it
 * against a budget (`readSequenceWithBudget` in `clients/runtime-session.ts`,
 * default 250ms, overridable via `PI_LENS_SEQUENCE_READ_BUDGET_MS` for
 * tests). On timeout, session_start proceeds immediately with a safe
 * cold-start sequence (`{ projectSeq: 0, fileSeqByPath: empty }` — this only
 * gates snapshot freshness, never correctness) and the real read keeps
 * running in the background, re-seeding the runtime once it resolves.
 *
 * These tests inject a controllable slow read (a stubbed
 * `readLatestProjectSequenceAsync` that resolves only when the test tells
 * it to) instead of a real wall-clock sleep, per #1024's OS-agnostic
 * discipline — no flaky timing assumptions, and it proves the bound holds
 * even when the underlying read has not yet returned at all. The "healthy
 * path" test proves the fast case is unaffected. All tests FAIL on pre-fix
 * code: pre-fix, `handleSessionStart` awaits the slow read directly (no
 * race), so the "returns within budget" and "cold-start fallback" assertions
 * would time out / never observe a `timedOut: true` metadata flag.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSequenceIndex } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const logLatencySpy = vi.hoisted(() => vi.fn());
const readLatestProjectSequenceAsyncSpy = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: logLatencySpy };
});

vi.mock("../../clients/project-changes.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-changes.js")>();
	return {
		...actual,
		readLatestProjectSequenceAsync: readLatestProjectSequenceAsyncSpy,
	};
});

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => ({
		touchFile: vi.fn().mockResolvedValue(undefined),
		supportsLSP: () => false,
	})),
}));

import { handleSessionStart } from "../../clients/runtime-session.js";

function makeDeps(
	ctxCwd: string,
	runtime: RuntimeCoordinator,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
		ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
		knipClient: { isAvailable: () => false, ensureAvailable: async () => false },
		jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
		depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		...overrides,
	} as any;
}

function makeProject(env: { tmpDir: string }): string {
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
	return cwd;
}

/** A deferred promise the test controls the settle timing of. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function spyOnSeed(runtime: RuntimeCoordinator): ReturnType<typeof vi.fn> {
	const seedSpy = vi.fn();
	const original = runtime.seedProjectSequence.bind(runtime);
	runtime.seedProjectSequence = ((...args: [number, Map<string, number>?]) => {
		seedSpy(...args);
		return (original as (...a: typeof args) => void)(...args);
	}) as typeof runtime.seedProjectSequence;
	return seedSpy;
}

describe("#1162 — bounded session_start sequence read", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevArgv: string[];
	let prevStartupMode: string | undefined;
	let prevBudget: string | undefined;
	let prevDelay: string | undefined;
	let prevDataDir: string | undefined;
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;

	beforeEach(() => {
		prevArgv = process.argv;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		prevBudget = process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		prevDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevDataDir = process.env.PILENS_DATA_DIR;
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		// Avoid the unrelated first-session quick-warmup heuristic (#1154)
		// firing background work that would confuse these assertions.
		globals.__piLensFirstSessionDone = true;
		globals.__piLensWarmupScheduled = true;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "30";
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
		logLatencySpy.mockClear();
		readLatestProjectSequenceAsyncSpy.mockReset();
		_resetSubagentModeForTests();
	});

	afterEach(() => {
		process.argv = prevArgv;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		if (prevBudget === undefined)
			delete process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		else process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = prevBudget;
		if (prevDelay === undefined) delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevDelay;
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		vi.restoreAllMocks();
		_resetSubagentModeForTests();
	});

	it("returns within budget and falls back to cold-start when the sequence read stalls, then reseeds in the background once it resolves", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-slow-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const slowResult: ProjectSequenceIndex = {
				projectSeq: 42,
				fileSeqByPath: new Map([["/some/file.ts", 7]]),
			};
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			const startedAt = Date.now();
			await handleSessionStart(makeDeps(cwd, runtime));
			const elapsed = Date.now() - startedAt;

			// Bounded: session_start returned even though the injected read has
			// NOT resolved yet — pre-fix this `await` would hang until `slow`
			// settles (never, in this test), so this line alone fails pre-fix.
			// Generous slack above the 30ms budget absorbs CI scheduling jitter
			// while staying far below any real host-pressure stall.
			expect(elapsed).toBeLessThan(2000);

			// Cold-start fallback: seeded with the safe empty sentinel.
			expect(seedSpy).toHaveBeenCalledWith(0, new Map());

			// Never silent (shape 10): the latency line distinguishes the
			// fallback from a healthy read.
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read",
					metadata: expect.objectContaining({ timedOut: true }),
				}),
			);

			// Now let the slow read resolve and confirm the deferred reseed runs.
			seedSpy.mockClear();
			logLatencySpy.mockClear();
			slow.resolve(slowResult);
			await vi.waitFor(() => {
				expect(seedSpy).toHaveBeenCalledWith(42, slowResult.fileSeqByPath);
			});
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
					metadata: expect.objectContaining({ deferred: true, entries: 1 }),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("seeds normally on a healthy (fast) read — no fallback", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-fast-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const fastResult: ProjectSequenceIndex = {
				projectSeq: 3,
				fileSeqByPath: new Map([["/some/other.ts", 1]]),
			};
			readLatestProjectSequenceAsyncSpy.mockResolvedValue(fastResult);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));

			expect(seedSpy).toHaveBeenCalledWith(3, fastResult.fileSeqByPath);
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read",
					metadata: expect.objectContaining({ timedOut: false }),
				}),
			);
			// Healthy path never falls back — no deferred-reseed phase logged.
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does NOT reseed in the background for a one-shot `pi --print` invocation (shape 4 screen)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-print-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.argv = [...prevArgv, "--print"];
		try {
			const cwd = makeProject(env);
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));
			expect(seedSpy).toHaveBeenCalledWith(0, new Map());
			seedSpy.mockClear();
			logLatencySpy.mockClear();

			slow.resolve({ projectSeq: 99, fileSeqByPath: new Map() });
			// Give the (would-be) background continuation a generous window to
			// run if it were going to — post-fix it must not, since a one-shot
			// print process has no future session in this process to benefit.
			await new Promise((resolve) => setTimeout(resolve, 150));

			expect(seedSpy).not.toHaveBeenCalled();
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
