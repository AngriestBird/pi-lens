/**
 * Regression test for #1785's review round finding F1 (HIGH, "Probe D"
 * shape): quick mode's own cold-start warmup (`PI_LENS_WARMUP_DELAY_MS`,
 * default 2000ms) can fire and save a snapshot built from the LIVE runtime
 * — which, while this same session_start's sequence read is still stalled
 * past its budget, has empty `cachedExports` — while the deferred
 * retroactive-hydration fix from the first #1785 round is still waiting on
 * that same stalled read. If retroactive hydration re-loads the snapshot
 * from disk at that point, it reads the warmup's EMPTIED body, not the good
 * one that existed when the stall began — `isProjectSnapshotFresh` still
 * says "fresh" (same seq 0, since nothing bumped it), so it "hydrates"
 * nothing while claiming success.
 *
 * The fix (see `preWarmupSnapshotForRetroHydrate` and
 * `retroactivelyHydrateAfterDeferredSequence` in
 * `clients/runtime-session.ts`) captures the on-disk snapshot BEFORE the
 * warmup timer is armed and reuses that captured value for retroactive
 * hydration — never re-loading from disk once a warmup could have run. This
 * test drives the exact interleaving: save a good snapshot, stall the
 * sequence read, let the REAL warmup timer fire and overwrite the on-disk
 * snapshot, THEN resolve the stalled read — and asserts the runtime still
 * ends up with the pre-warmup exports, not the emptied ones the warmup left
 * behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSequenceIndex } from "../../clients/project-changes.js";
import {
	loadProjectSnapshot,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
	type ProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const readLatestProjectSequenceAsyncSpy = vi.hoisted(() => vi.fn());

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

function makeDeps(ctxCwd: string, runtime: RuntimeCoordinator) {
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
	} as any;
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

describe("#1785 review round F1 — retroactive hydration survives a warmup save mid-stall", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevArgv: string[];
	let prevStartupMode: string | undefined;
	let prevBudget: string | undefined;
	let prevWarmupDelay: string | undefined;
	let prevColdStart: string | undefined;
	let prevDataDir: string | undefined;
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;

	beforeEach(() => {
		prevArgv = process.argv;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		prevBudget = process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		prevWarmupDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevColdStart = process.env.PI_LENS_COLD_START_QUICK;
		prevDataDir = process.env.PILENS_DATA_DIR;
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		// Opposite of the #1162 sequence-read-budget suite's convention: THIS
		// suite needs the warmup to actually arm and fire.
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "20";
		process.env.PI_LENS_WARMUP_DELAY_MS = "5";
		delete process.env.PI_LENS_COLD_START_QUICK;
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
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
		if (prevWarmupDelay === undefined)
			delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevWarmupDelay;
		if (prevColdStart === undefined) delete process.env.PI_LENS_COLD_START_QUICK;
		else process.env.PI_LENS_COLD_START_QUICK = prevColdStart;
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		vi.restoreAllMocks();
		_resetSubagentModeForTests();
	});

	it("hydrates from the pre-warmup snapshot, not the emptied one the warmup saves mid-stall", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-race-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
			const goodExportPath = path.join(cwd, "index.ts");
			// `cwd` itself is the resolved snapshot root: `.git` right inside it
			// makes `findNearestProjectRoot` return `cwd` unchanged (mirrors the
			// #1162 sibling suite's `makeProject` + direct-`cwd` snapshot usage).
			const snapshotRoot = cwd;

			// The good, pre-session snapshot — what a prior session persisted.
			// Deliberately no `startupScan`, so the warmup below is forced to
			// recompute and re-save rather than reuse a cached verdict.
			saveProjectSnapshot(snapshotRoot, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: snapshotRoot,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["good", goodExportPath]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			} satisfies ProjectSnapshot);

			// Stall the sequence read for the whole test — it never resolves
			// until this test explicitly does so below.
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));

			// Synchronous return: the read hasn't settled, so the freshness gate
			// correctly refuses to hydrate yet.
			expect(runtime.cachedExports.get("good")).toBeUndefined();

			// Let the REAL warmup timer (armed for 5ms) fire and complete its
			// save — proving the on-disk snapshot really is overwritten with an
			// empty `cachedExports` (built from the still-cold live runtime)
			// before the stalled sequence read ever resolves. This is the exact
			// interleaving #1785's review round named: the warmup's save landing
			// INSIDE the stall window this fix targets.
			await vi.waitFor(
				() => {
					const onDisk = loadProjectSnapshot(snapshotRoot);
					expect(onDisk?.cachedExports).toEqual([]);
				},
				{ timeout: 5000, interval: 10 },
			);

			// NOW the stalled read resolves — confirming (correctly) that
			// nothing changed since the ORIGINAL good snapshot (seq 0, matching
			// an empty change log).
			slow.resolve({ projectSeq: 0, fileSeqByPath: new Map() });

			await vi.waitFor(
				() => {
					expect(runtime.cachedExports.get("good")).toBe(goodExportPath);
				},
				{ timeout: 5000, interval: 10 },
			);
		} finally {
			env.cleanup();
		}
	});
});
