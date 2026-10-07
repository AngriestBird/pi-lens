/**
 * Event-loop occupancy guard for the per-edit cascade graph rebuild.
 *
 * flake-shape: elapsed-time-assertion — the two pure-synchronous cases (the
 * reverse-dependency patch and the impact-cascade traversal) have no
 * deterministic proxy: the defect shape is a complexity class (O(n^2)), and
 * only measured t(4N)/t(N) separates it from linear work. They assert a
 * dimensionless ratio of two real clock deltas, never an absolute budget.
 *
 * `buildOrUpdateGraph` runs on EVERY write/edit (via `computeCascadeForFile` in
 * the per-edit pipeline). Even on a pure cache hit it must re-derive the
 * workspace source-file list and its size/mtime signature, which walks the
 * project tree and stats every source file; that work must yield to the event
 * loop in chunks instead of holding it for the whole walk.
 *
 * Why this file has no millisecond budget (#4046). The previous version
 * asserted `maxSyncBlock < 300 ms` through an independent sampler. It was red
 * on healthy code and green under the regression it named:
 *   - `computeImpactCascade` is one synchronous call, so max block == wall.
 *     It costs ~85 ms on an idle fast core and 337-440 ms at a 25% CPU share
 *     (cpu pinned, three busy loops), so the runner's CPU share alone decided
 *     the verdict (10 of 82 shard-2 runs exhausted their retries).
 *   - its 1200-file fixture exceeded the 1,000-file review-graph cap, so
 *     `buildOrUpdateGraph` returned `mode: "skipped"` before reaching the
 *     chunked stat loops; the builder yield mutant stayed green.
 *
 * The replacement counts behaviour the host cannot change:
 *   - cold and warm builds: the number of `setImmediate` yields the real
 *     build makes (healthy 18-20, builder yield off 0), plus zero synchronous
 *     `readdirSync` calls on the warm path (healthy 0, synchronous walk 154),
 *     on a fixture under the cap whose build mode is asserted not `skipped`;
 *   - the pure-sync operations: the ratio t(4N)/t(N), min of 5 reps, against
 *     a limit of 7 (measurements are in the PR that introduced this header).
 *
 * NB: tests run against the COMPILED .js (npm run build emits in-place and
 * vitest resolves the `.js` specifier to it), so a source change only takes
 * effect after a rebuild; CI builds before `npm test`.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { patchReverseDependencyIndex } from "../../clients/reverse-deps.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getGraphBuildInfoForGraph,
} from "../../clients/review-graph/builder.js";
import { computeImpactCascade } from "../../clients/review-graph/query.js";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import { generateSourceTree } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

// Below the 1,000-file review-graph cap (`getReviewGraphMaxFiles`): at 1,001
// the build returns `mode: "skipped"` before the chunked stat loops run, which
// is how the previous 1200-file fixture went vacuous. The precondition in each
// build test fails loudly if the fixture ever crosses the cap again.
const TREE_SIZE = 900;
// The builder yields to the event loop every STAT_YIELD_EVERY stats
// (`clients/review-graph/builder.ts`). Named here as a literal on purpose: a
// floor derived from an exported constant would shrink with it and stay green
// under the mutation this guard exists to catch (the cadence raised to
// 1000000). Changing the builder cadence means changing this number.
const STAT_YIELD_EVERY = 100;
// One yield per chunk, minus one for the partial last chunk. Healthy builds
// make 18-20 yields at TREE_SIZE 900; a build whose chunk yield is off makes 0.
const MIN_BUILD_YIELDS = Math.floor(TREE_SIZE / STAT_YIELD_EVERY) - 1;

// t(4N)/t(N) of linear work is 4 plus noise; the limit sits between the
// healthy spread and the O(n^2) mutants (4N costs 16x there, noise aside).
const SCALING_RATIO_LIMIT = 7;
const SCALING_REPS = 5;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cascade-occupancy-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	// Force a cold per-invocation cache so each build re-derives the
	// source-file list + signature (the dominant per-edit cost we hardened).
	clearGraphCache();
	_resetGeneratedArtifactCaches();
});

/**
 * Run `work` and count what it did to the event loop: every `setImmediate`
 * yield it requested and every synchronous `readdirSync` it issued. Counts do
 * not depend on how fast the host is, which a millisecond budget cannot say.
 */
async function observeLoopYields<T>(
	work: () => Promise<T>,
): Promise<{ result: T; yields: number; readdirSyncCalls: number }> {
	const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
	// `vi.spyOn` on the ESM namespace of a builtin fails: patch the CJS default
	// export and sync the ESM bindings (the pattern path-utils.test.ts uses).
	const readdirSyncSpy = vi.spyOn(fs, "readdirSync");
	syncBuiltinESMExports();
	try {
		const result = await work();
		return {
			result,
			yields: setImmediateSpy.mock.calls.length,
			readdirSyncCalls: readdirSyncSpy.mock.calls.length,
		};
	} finally {
		setImmediateSpy.mockRestore();
		readdirSyncSpy.mockRestore();
		syncBuiltinESMExports();
	}
}

describe(`cascade graph rebuild event-loop yields (${TREE_SIZE} files)`, () => {
	it(
		"cold buildOrUpdateGraph yields at the stat chunk cadence",
		{
			timeout: 60_000,
		},
		async () => {
			clearReviewGraphWorkspaceCache();
			const facts = new FactStore();
			const changed = [path.join(tmpDir, "src", "file0.ts")];
			const { result: graph, yields } = await observeLoopYields(() =>
				buildOrUpdateGraph(tmpDir, changed, facts),
			);
			// Precondition (#4046): the fixture reaches the chunked stat loops. A
			// `skipped` build makes zero yields; fail on that cause, not on the count.
			expect(getGraphBuildInfoForGraph(graph).mode).not.toBe("skipped");
			expect(graph.nodes.size).toBeGreaterThan(0);
			expect(yields).toBeGreaterThanOrEqual(MIN_BUILD_YIELDS);
		},
	);

	it(
		"warm (cache-hit) buildOrUpdateGraph yields at the stat chunk cadence and walks no directory synchronously",
		{
			timeout: 60_000,
		},
		async () => {
			const facts = new FactStore();
			const changed = [path.join(tmpDir, "src", "file0.ts")];
			// Prime the workspace cache so this run is a pure cache hit: the exact
			// per-edit scenario where the signature re-derivation dominates.
			await buildOrUpdateGraph(tmpDir, changed, facts);
			clearGraphCache();
			const {
				result: graph,
				yields,
				readdirSyncCalls,
			} = await observeLoopYields(() =>
				buildOrUpdateGraph(tmpDir, changed, facts),
			);
			expect(getGraphBuildInfoForGraph(graph).mode).not.toBe("skipped");
			expect(graph.nodes.size).toBeGreaterThan(0);
			expect(yields).toBeGreaterThanOrEqual(MIN_BUILD_YIELDS);
			// The async walk reads directories through `fs.promises.readdir`, which
			// yields per directory. A synchronous `readdirSync` here is the
			// non-yielding walk regression (154 calls when reintroduced); the cold
			// path legitimately reads its directories, so only this path asserts it.
			expect(readdirSyncCalls).toBe(0);
		},
	);
});

describe("pure-synchronous cascade operations scale linearly", () => {
	it(
		"reverse-dependency delta patch: t(4N)/t(N) stays under the scaling limit",
		{
			timeout: 60_000,
		},
		() => {
			// N is chosen so t(N) is well above timer noise; N=100 measured a noisy
			// ratio on healthy code at a 25% CPU share.
			const N = 500;
			expectLinearScaling((n) => {
				const index = {
					projectRoot: tmpDir,
					generatedAt: new Date().toISOString(),
					imports: Object.fromEntries(
						Array.from({ length: n }, (_, i) => [`file-${i}.ts`, []]),
					),
					importedBy: {},
					source: "review-graph" as const,
				};
				const changes = Array.from({ length: n }, (_, i) => ({
					filePath: path.join(tmpDir, `file-${i}.ts`),
					priorTargets: [],
					newTargets: [path.join(tmpDir, `dependency-${i}.ts`)],
					existedBefore: true,
					existsAfter: true,
				}));
				return () => {
					patchReverseDependencyIndex(index, changes);
				};
			}, N);
		},
	);

	it(
		"impact-cascade traversal: t(4N)/t(N) stays under the scaling limit",
		{
			timeout: 60_000,
		},
		() => {
			const N = 2500;
			expectLinearScaling((n) => {
				const graph = impactGraph(n);
				const seed = path.join(tmpDir, "seed.ts");
				return () => {
					computeImpactCascade(graph, seed);
				};
			}, N);
		},
	);
});

/**
 * Assert `t(4N)/t(N) < SCALING_RATIO_LIMIT`, each time the minimum of
 * SCALING_REPS runs. The minimum rejects descheduling spikes; the ratio cancels
 * the host's CPU share, which an absolute millisecond budget cannot. The two
 * sizes are timed in alternation so a share change mid-test (a neighbour
 * waking up) lands on both, not on one side of the ratio. `prepare(n)` builds
 * the fixture OUTSIDE the timed region and returns the operation to time.
 */
function expectLinearScaling(prepare: (n: number) => () => void, n: number) {
	const timeOnce = (size: number): number => {
		const run = prepare(size);
		const start = performance.now();
		run();
		return performance.now() - start;
	};
	// Untimed warm-up of both sizes: JIT and first-touch costs.
	timeOnce(n);
	timeOnce(4 * n);
	let small = Number.POSITIVE_INFINITY;
	let large = Number.POSITIVE_INFINITY;
	for (let rep = 0; rep < SCALING_REPS; rep++) {
		small = Math.min(small, timeOnce(n));
		large = Math.min(large, timeOnce(4 * n));
	}
	expect(
		large / small,
		`t(${4 * n})=${large.toFixed(1)}ms / t(${n})=${small.toFixed(1)}ms`,
	).toBeLessThan(SCALING_RATIO_LIMIT);
}

function impactGraph(dependents: number): ReviewGraph {
	const graph = emptyGraph();
	const seed = path.join(tmpDir, "seed.ts");
	const seedNode = "file:seed";
	graph.nodes.set(seedNode, {
		id: seedNode,
		kind: "file",
		language: "typescript",
		filePath: seed,
	});
	graph.fileNodes.set(seed, seedNode);
	for (let i = 0; i < dependents; i++) {
		const nodeId = `file:dependent-${i}`;
		const file = path.join(tmpDir, `dependent-${i}.ts`);
		graph.nodes.set(nodeId, {
			id: nodeId,
			kind: "file",
			language: "typescript",
			filePath: file,
		});
		graph.edges.push({ from: nodeId, to: seedNode, kind: "imports" });
	}
	graph.edgesByTo.set(seedNode, graph.edges);
	return graph;
}

function emptyGraph(): ReviewGraph {
	return {
		version: "v8",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}
