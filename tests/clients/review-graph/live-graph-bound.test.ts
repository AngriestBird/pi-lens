import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	_getReviewGraphWorkspaceGraphForTests,
	_persistedCoverageForTests,
	_resetRetainedGraphSitesForTests,
	_setReviewGraphWorkspaceEntryForTests,
	_setSessionReviewGraphFactForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	getLastGraphBuildInfo,
	clearReviewGraphWorkspaceCache,
	estimateReviewGraphStoreBytes,
	getReviewGraphWorkspaceCacheSnapshot,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";

// #2255: the live review graph had no size bound — only the on-disk snapshot did.
// These tests pin that every process-lifetime retention site is capped, that the
// cap never yields an empty graph, that an already-partial graph is not exempt,
// and that a cap-trimmed graph stays honest on disk while staying usable as an
// incremental base in this process.

// Production node paths arrive folded through `normalizeGraphSourcePath`, which is
// `normalizeMapKey`. The centrality selection keys off the same fold, so a fixture
// that skips it is not production-shaped: on Linux every lookup missed and the cap
// retained nothing (#2255 review F1). Fold the fixture the way production does.
const KEY = normalizeMapKey(path.resolve("memcap-workspace"));
const filePathFor = (i: number): string =>
	normalizeMapKey(path.resolve("memcap-workspace", "src", `f${i}.ts`));

/**
 * A graph with `fileCount` file nodes, one symbol node each, import edges between
 * file nodes (so reverse-dependency centrality has something to rank), and bulk
 * reference edges. `fileNodes` is populated because the real builder hands the
 * retention seam a fully-indexed graph.
 */
function buildGraph(fileCount: number, refEdges: number): ReviewGraph {
	const nodes = new Map();
	const fileNodes = new Map<string, string>();
	const symbolNodesByFile = new Map<string, string[]>();
	const fileIds: string[] = [];
	const symIds: string[] = [];
	for (let i = 0; i < fileCount; i += 1) {
		const filePath = filePathFor(i);
		const fileId = `file:${i}`;
		const symId = `sym:${i}`;
		nodes.set(fileId, {
			id: fileId,
			kind: "file",
			language: "typescript",
			filePath,
		});
		nodes.set(symId, {
			id: symId,
			kind: "symbol",
			language: "typescript",
			filePath,
			metadata: { payload: `symbol-${i}` },
		});
		fileNodes.set(filePath, fileId);
		symbolNodesByFile.set(filePath, [symId]);
		fileIds.push(fileId);
		symIds.push(symId);
	}
	const edges = [];
	for (let i = 0; i < fileCount; i += 1) {
		edges.push({
			from: fileIds[i],
			to: fileIds[(i + 1) % fileCount],
			kind: "imports" as const,
		});
		edges.push({
			from: fileIds[i],
			to: fileIds[(i + 2) % fileCount],
			kind: "imports" as const,
		});
	}
	for (let i = 0; i < refEdges; i += 1) {
		edges.push({
			from: symIds[i % symIds.length],
			to: symIds[(i * 13 + 1) % symIds.length],
			kind: "references" as const,
			metadata: { payload: `ref-${i}` },
		});
	}
	return {
		version: "membound-test",
		builtAt: new Date().toISOString(),
		nodes,
		edges,
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes,
		symbolNodesByFile,
		changedSymbolsByFile: new Map(),
	};
}

/**
 * A graph the centrality selection cannot rank: symbol nodes carry a file path,
 * but no file nodes and no import edges exist, so the reverse-dependency index is
 * empty and every ranked lookup misses. This is the shape that silently retained
 * nothing (#2255 review F4).
 */
function unrankableGraph(nodeCount: number): ReviewGraph {
	const nodes = new Map();
	for (let i = 0; i < nodeCount; i += 1) {
		nodes.set(`sym:${i}`, {
			id: `sym:${i}`,
			kind: "symbol",
			language: "typescript",
			filePath: filePathFor(i),
			metadata: { payload: `symbol-${i}` },
		});
	}
	return {
		version: "membound-test",
		builtAt: new Date().toISOString(),
		nodes,
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

const findGroup = (kind: string) =>
	getDegradationSummary().find((g) => g.kind === kind);

const OVER_BUDGET = 150 * 1024;
const AMPLE_BUDGET = 512 * 1024 * 1024;

describe("live review-graph in-memory bound (#2255)", () => {
	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
		_resetRetainedGraphSitesForTests();
		resetDegradationLedger();
		delete process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES;
	});
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		_resetRetainedGraphSitesForTests();
		resetDegradationLedger();
		delete process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES;
	});

	it("caps the retained graph to the in-memory byte budget", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		const graph = buildGraph(250, 1000);
		const uncappedBytes = estimateReviewGraphStoreBytes(
			graph.nodes.size,
			graph.edges.length,
		);
		expect(uncappedBytes).toBeGreaterThan(OVER_BUDGET * 2);

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.residentBytes).toBeGreaterThan(0);
		expect(snapshot.residentBytes).toBeLessThan(OVER_BUDGET * 1.25);
		expect(snapshot.totalNodes).toBeGreaterThan(0);
		expect(snapshot.totalNodes).toBeLessThan(graph.nodes.size);
	});

	it("records a bounded ledger entry naming the trimmed cwd", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		_setReviewGraphWorkspaceEntryForTests(KEY, buildGraph(250, 1000));

		const group = findGroup("review-graph-memory-cap");
		expect(group).toBeDefined();
		expect(group?.latestReasons.some((r) => r.subject === KEY)).toBe(true);
	});

	it("leaves an in-budget graph whole and records nothing", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(AMPLE_BUDGET);
		const graph = buildGraph(250, 1000);
		const originalNodes = graph.nodes.size;
		const originalEdges = graph.edges.length;

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBe(originalNodes);
		expect(snapshot.totalEdges).toBe(originalEdges);
		expect(
			_getReviewGraphWorkspaceGraphForTests(KEY)?.persistCoverage,
		).toBeUndefined();
		expect(findGroup("review-graph-memory-cap")).toBeUndefined();
	});

	// F3: a full build whose source walk hit its entry budget sets partial:true on
	// a graph that is still over the memory budget. Exempting partials skipped the
	// exact population the bound targets.
	it("caps an already-partial graph instead of exempting it", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		const graph = buildGraph(250, 1000);
		graph.persistCoverage = {
			partial: true,
			cap: 500_000,
			totalNodes: graph.nodes.size,
			totalEdges: graph.edges.length,
			persistedNodes: graph.nodes.size,
			persistedEdges: graph.edges.length,
			totalFiles: 250,
			persistedFiles: 250,
			sourceFilesTruncated: true,
		};

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBeLessThan(graph.nodes.size);
		expect(snapshot.residentBytes).toBeLessThan(OVER_BUDGET * 1.25);
	});

	// F4: a selection that keeps nothing turns "too big" into "no graph", and every
	// query then reads as a clean empty result.
	it("never retains an empty graph, and says so under its own kind", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		const graph = unrankableGraph(500);

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBeGreaterThan(0);
		expect(snapshot.totalNodes).toBeLessThan(graph.nodes.size);
		const floor = findGroup("review-graph-memory-cap-floor");
		expect(floor).toBeDefined();
		expect(floor?.latestReasons.some((r) => r.subject === KEY)).toBe(true);
	});

	// F1: the selection ranks by `normalizeMapKey`-folded paths but used to key its
	// node groups by the RAW `node.filePath`. Any unfolded path missed every lookup
	// and produced an empty selection. Relative paths fold on every OS, so this
	// pins the fold itself rather than a platform's separator conventions.
	it("selects real nodes when node paths are not pre-folded", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		const graph = buildGraph(250, 1000);
		for (const node of graph.nodes.values()) {
			if (node.filePath)
				node.filePath = path.relative(process.cwd(), node.filePath);
		}

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBeGreaterThan(0);
		// The centrality selection must be what kept them, not the empty-result
		// floor rescuing a lookup that missed every group.
		expect(findGroup("review-graph-memory-cap-floor")).toBeUndefined();
	});

	// F2: the workspace cache is not the only process-lifetime retention site.
	// `session.reviewGraph` lands on FactStores that are module-scope, one of which
	// is never cleared, so an unbounded value there defeats the cache bound.
	it("bounds the graph retained on session.reviewGraph", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		const graph = buildGraph(250, 1000);
		const facts = new FactStore();

		_setSessionReviewGraphFactForTests(KEY, facts, graph);

		const retained = facts.getSessionFact<ReviewGraph>("session.reviewGraph");
		expect(retained).toBeDefined();
		expect(retained?.nodes.size).toBeLessThan(graph.nodes.size);
		expect(
			estimateReviewGraphStoreBytes(
				retained?.nodes.size ?? 0,
				retained?.edges.length ?? 0,
			),
		).toBeLessThan(OVER_BUDGET * 1.25);
	});

	// F2, second half: the sample read clean while a full graph was still resident
	// on the fact, during the exact heap exhaustion it is cited to prove against.
	it("counts session-fact retention in the memory sample", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(AMPLE_BUDGET);
		const graph = buildGraph(250, 1000);
		const facts = new FactStore();

		// No cache entry at all — the fact is the only retention site.
		_setSessionReviewGraphFactForTests(KEY, facts, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBe(graph.nodes.size);
		expect(snapshot.residentBytes).toBeGreaterThan(0);
	});

	it("counts a graph held by both sites once, not twice", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(AMPLE_BUDGET);
		const graph = buildGraph(250, 1000);
		const facts = new FactStore();

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);
		_setSessionReviewGraphFactForTests(KEY, facts, graph);

		expect(getReviewGraphWorkspaceCacheSnapshot().totalNodes).toBe(
			graph.nodes.size,
		);
	});

	// F5: cap-trimmed and walk-truncated are different facts. Conflating them put
	// an over-budget repository on a full walk every turn.
	it("marks a cap-trimmed graph partial for readers and base-eligible in-process", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		_setReviewGraphWorkspaceEntryForTests(KEY, buildGraph(250, 1000));

		const coverage =
			_getReviewGraphWorkspaceGraphForTests(KEY)?.persistCoverage;
		// Honest to every coverage-reporting consumer...
		expect(coverage?.partial).toBe(true);
		// ...and distinguishable from a walk-truncated graph for the base gates.
		expect(coverage?.capTrimmed).toBe(true);
		expect(coverage?.sourceFilesTruncated).toBeUndefined();
	});

	// F5, the behavior the marker split exists for. Refusing a cap-trimmed graph as
	// a base put an over-budget repository on a full O(project) walk every turn,
	// which is worse than the pre-bound behavior it replaced.
	it("rebuilds incrementally from a cap-trimmed graph instead of walking again", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memcap-base-"));
		try {
			const facts = new FactStore();
			const a = path.join(dir, "a.ts");
			fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
			// Budget of 1 byte: every build this test does is over budget, so the
			// retained graph is always cap-trimmed.
			process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = "1";
			await buildOrUpdateGraph(dir, [a], facts);
			expect(getLastGraphBuildInfo().reused).toBe(false); // full build

			const b = path.join(dir, "b.ts");
			fs.writeFileSync(b, "export function bravoSymbol() {\n\treturn 2;\n}\n");
			clearGraphCache(); // drop promise-dedup; keep the warm workspace cache

			await buildOrUpdateGraph(dir, [b], facts);

			const info = getLastGraphBuildInfo();
			expect(info.reused).toBe(true);
			expect(info.mode).not.toBe("full");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never persists the process-local base-eligibility marker", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(OVER_BUDGET);
		_setReviewGraphWorkspaceEntryForTests(KEY, buildGraph(250, 1000));
		const coverage =
			_getReviewGraphWorkspaceGraphForTests(KEY)?.persistCoverage;

		const persisted = _persistedCoverageForTests(coverage);

		// A snapshot read back in a later process cannot vouch for the walk, so it
		// must not inherit base-eligibility — but it stays honestly partial.
		expect(persisted?.capTrimmed).toBeUndefined();
		expect(persisted?.partial).toBe(true);
	});
});
