import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	_getReviewGraphWorkspaceGraphForTests,
	_setReviewGraphWorkspaceEntryForTests,
	clearReviewGraphWorkspaceCache,
	estimateReviewGraphStoreBytes,
	getReviewGraphWorkspaceCacheSnapshot,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";

// #2255: the live review graph retained in `_workspaceGraphCache` had no size
// bound — only the on-disk snapshot did. These tests pin that the RETAINED graph
// is capped to the in-memory byte budget, that an in-budget graph is left whole,
// and that a trim is provable from the degradation ledger.

const KEY = "C:/memcap/workspace";
const FILE_PREFIX = "C:/memcap/src";

/**
 * A graph with `fileCount` file nodes, one symbol node each, import edges between
 * file nodes (so reverse-dependency centrality has something to rank), and bulk
 * reference edges. `fileNodes` is pre-populated because the real builder hands
 * `setWorkspaceGraph` a fully-indexed graph, and the centrality selection reads
 * `graph.fileNodes`.
 */
function buildGraph(fileCount: number, refEdges: number): ReviewGraph {
	const nodes = new Map();
	const fileNodes = new Map<string, string>();
	const symbolNodesByFile = new Map<string, string[]>();
	const fileIds: string[] = [];
	const symIds: string[] = [];
	for (let i = 0; i < fileCount; i += 1) {
		const filePath = `${FILE_PREFIX}/f${i}.ts`;
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

describe("live review-graph in-memory bound (#2255)", () => {
	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
		resetDegradationLedger();
		delete process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES;
	});
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		resetDegradationLedger();
		delete process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES;
	});

	it("caps the retained graph to the in-memory byte budget", () => {
		const budget = 150 * 1024;
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(budget);
		const graph = buildGraph(250, 1000);
		const uncappedBytes = estimateReviewGraphStoreBytes(
			graph.nodes.size,
			graph.edges.length,
		);
		expect(uncappedBytes).toBeGreaterThan(budget * 2);

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		// The retained graph is a strict subset, and its estimated bytes land at or
		// under the budget (whole-file-group granularity allows a small overshoot).
		expect(snapshot.residentBytes).toBeGreaterThan(0);
		expect(snapshot.residentBytes).toBeLessThan(budget * 1.25);
		expect(snapshot.totalNodes).toBeLessThan(graph.nodes.size);
		expect(snapshot.totalNodes).toBeGreaterThan(0);

		const stored = _getReviewGraphWorkspaceGraphForTests(KEY);
		// The capped graph is read-only orientation data: the partial marker is what
		// makes the next build re-derive the full graph instead of extending a
		// truncated base (#2243 posture).
		expect(stored?.persistCoverage?.partial).toBe(true);
	});

	it("records a bounded ledger entry naming the trimmed cwd", () => {
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(150 * 1024);
		_setReviewGraphWorkspaceEntryForTests(KEY, buildGraph(250, 1000));

		const group = getDegradationSummary().find(
			(g) => g.kind === "review-graph-memory-cap",
		);
		expect(group).toBeDefined();
		expect(group?.latestReasons.some((r) => r.subject === KEY)).toBe(true);
	});

	it("leaves an in-budget graph whole and records nothing", () => {
		// A budget far above the graph's cost: no trim, no partial marker, no record.
		process.env.PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES = String(512 * 1024 * 1024);
		const graph = buildGraph(250, 1000);
		const originalNodes = graph.nodes.size;
		const originalEdges = graph.edges.length;

		_setReviewGraphWorkspaceEntryForTests(KEY, graph);

		const snapshot = getReviewGraphWorkspaceCacheSnapshot();
		expect(snapshot.totalNodes).toBe(originalNodes);
		expect(snapshot.totalEdges).toBe(originalEdges);
		const stored = _getReviewGraphWorkspaceGraphForTests(KEY);
		expect(stored?.persistCoverage?.partial).toBeUndefined();
		expect(
			getDegradationSummary().find((g) => g.kind === "review-graph-memory-cap"),
		).toBeUndefined();
	});
});
