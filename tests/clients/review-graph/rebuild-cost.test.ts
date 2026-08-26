import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	_getReviewGraphRebuildCountersForTests,
	_resetReviewGraphRebuildCountersForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getGraphImportChanges,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

/**
 * A ring of `count` modules where every module imports and calls two others.
 * Node and edge counts therefore scale linearly with `count`, while the fan-in
 * of any single file stays at 2 — exactly the shape the #2074 acceptance
 * criteria need to separate per-graph cost from per-changed-file cost.
 */
function makeRing(count: number): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2074-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(root, ".git"), "");
	const src = path.join(root, "src");
	fs.mkdirSync(src, { recursive: true });
	for (let i = 0; i < count; i++) {
		const a = (i + 1) % count;
		const b = (i + 2) % count;
		fs.writeFileSync(
			path.join(src, `file${i}.ts`),
			`import { fn${a} } from "./file${a}.js";\n` +
				`import { fn${b} } from "./file${b}.js";\n` +
				`export function fn${i}(): number {\n` +
				`\treturn fn${a}() + fn${b}();\n` +
				`}\n`,
		);
	}
	return root;
}

interface RebuildProbe {
	graph: ReviewGraph;
	counters: { restoreComparisons: number; importTargetEdgeScans: number };
	nodes: number;
	edges: number;
}

/**
 * Warm the graph, then edit ONE file and rebuild through the #451 seq fast
 * path, counting only the rebuild's work.
 */
async function warmThenRebuildOneFile(root: string): Promise<RebuildProbe> {
	const changed = path.join(root, "src", "file0.ts");
	let seq = 0;
	const seqHint = {
		projectSeq: () => seq,
		getFilesChangedSince: () => [changed],
	};
	await buildOrUpdateGraph(root, [changed], new FactStore(), seqHint);
	seq++;
	fs.appendFileSync(changed, "\nexport const marker0 = 1;\n");
	clearGraphCache();
	_resetReviewGraphRebuildCountersForTests();
	const graph = await buildOrUpdateGraph(
		root,
		[changed],
		new FactStore(),
		seqHint,
	);
	return {
		graph,
		counters: _getReviewGraphRebuildCountersForTests(),
		nodes: graph.nodes.size,
		edges: graph.edges.length,
	};
}

/** The indexes `rebuildIndexes` would produce for `graph`, as plain data. */
function referenceIndexes(graph: ReviewGraph): {
	edgesByFrom: Array<[string, number]>;
	edgesByTo: Array<[string, number]>;
	fileNodes: Array<[string, string]>;
	symbolNodesByFile: Array<[string, string[]]>;
} {
	const edgesByFrom = new Map<string, number>();
	const edgesByTo = new Map<string, number>();
	const fileNodes = new Map<string, string>();
	const symbolNodesByFile = new Map<string, string[]>();
	for (const node of graph.nodes.values()) {
		if (node.kind === "file" && node.filePath) {
			fileNodes.set(node.filePath, node.id);
		}
		if (node.kind === "symbol" && node.filePath) {
			const ids = symbolNodesByFile.get(node.filePath) ?? [];
			ids.push(node.id);
			symbolNodesByFile.set(node.filePath, ids);
		}
	}
	for (const edge of graph.edges) {
		edgesByFrom.set(edge.from, (edgesByFrom.get(edge.from) ?? 0) + 1);
		edgesByTo.set(edge.to, (edgesByTo.get(edge.to) ?? 0) + 1);
	}
	const sortNum = (map: Map<string, number>): Array<[string, number]> =>
		[...map].sort(([a], [b]) => a.localeCompare(b));
	return {
		edgesByFrom: sortNum(edgesByFrom),
		edgesByTo: sortNum(edgesByTo),
		fileNodes: [...fileNodes].sort(([a], [b]) => a.localeCompare(b)),
		symbolNodesByFile: [...symbolNodesByFile]
			.map(([key, ids]) => [key, [...ids].sort()] as [string, string[]])
			.sort(([a], [b]) => a.localeCompare(b)),
	};
}

/** The indexes actually carried by `graph`, in the same plain-data shape. */
function liveIndexes(graph: ReviewGraph): ReturnType<typeof referenceIndexes> {
	const counts = (map: Map<string, unknown[]>): Array<[string, number]> =>
		[...map]
			.filter(([, values]) => values.length > 0)
			.map(([key, values]) => [key, values.length] as [string, number])
			.sort(([a], [b]) => a.localeCompare(b));
	return {
		edgesByFrom: counts(graph.edgesByFrom),
		edgesByTo: counts(graph.edgesByTo),
		fileNodes: [...graph.fileNodes].sort(([a], [b]) => a.localeCompare(b)),
		symbolNodesByFile: [...graph.symbolNodesByFile]
			.filter(([, ids]) => ids.length > 0)
			.map(([key, ids]) => [key, [...ids].sort()] as [string, string[]])
			.sort(([a], [b]) => a.localeCompare(b)),
	};
}

describe("review-graph one-file rebuild cost (#2074)", () => {
	it(
		"keeps rebuild work proportional to the changed file, not the graph",
		{ timeout: 240_000 },
		async () => {
			const small = await warmThenRebuildOneFile(makeRing(40));
			const large = await warmThenRebuildOneFile(makeRing(160));

			// Sanity: the fixture really did scale, so an O(graph) cost would show.
			expect(large.nodes).toBeGreaterThan(small.nodes * 3);
			expect(large.edges).toBeGreaterThan(small.edges * 3);

			// AC1a: metadata comparisons in restoreValidIncomingEdges are bounded by
			// the preserved-incoming set of the ONE changed file, so they do not
			// move when the graph quadruples. Before #2074 this counted one
			// JSON.stringify per edge in the whole graph.
			expect(large.counters.restoreComparisons).toBe(
				small.counters.restoreComparisons,
			);

			// AC1b: importTargetsForFile reads the changed file's own edgesByFrom
			// bucket. Before #2074 it scanned graph.edges twice per changed file.
			expect(large.counters.importTargetEdgeScans).toBe(
				small.counters.importTargetEdgeScans,
			);
			expect(large.counters.importTargetEdgeScans).toBeLessThan(
				small.edges / 2,
			);
		},
	);

	it(
		"reports existedBefore for a file already in the graph",
		{ timeout: 120_000 },
		async () => {
			const root = makeRing(12);
			const probe = await warmThenRebuildOneFile(root);
			const delta = getGraphImportChanges(probe.graph);
			expect(delta).toBeDefined();
			const change = delta?.changes.find((entry) =>
				entry.filePath.endsWith("file0.ts"),
			);
			expect(change).toBeDefined();
			// updateGraphFiles used to read existedBefore off the EMPTY fileNodes map
			// a fresh cloneGraph hands it, so a long-standing file always looked new.
			// clients/dispatch/integration.ts:1077 reads this to decide whether the
			// reverse-dependency index can be reused; a false negative here forces a
			// full reverse-deps rebuild on every incremental build.
			expect(change?.existedBefore).toBe(true);
			expect(change?.existsAfter).toBe(true);
		},
	);

	it(
		"leaves every derived index identical to a full reindex",
		{ timeout: 120_000 },
		async () => {
			const probe = await warmThenRebuildOneFile(makeRing(24));
			// Mutation guard for the incremental index maintenance that replaced the
			// terminal rebuildIndexes: dropping unindexEdge, addNode's
			// symbolNodesByFile upkeep, or resolveDeferredSymbolEdges' replacement
			// patching all leave the live indexes disagreeing with this reference.
			expect(liveIndexes(probe.graph)).toEqual(referenceIndexes(probe.graph));
			expect(probe.graph.edgesByFrom.size).toBeGreaterThan(0);
		},
	);

	it(
		"does not duplicate preserved incoming edges across repeated rebuilds",
		{ timeout: 120_000 },
		async () => {
			const root = makeRing(16);
			const changed = path.join(root, "src", "file0.ts");
			let seq = 0;
			const seqHint = {
				projectSeq: () => seq,
				getFilesChangedSince: () => [changed],
			};
			await buildOrUpdateGraph(root, [changed], new FactStore(), seqHint);
			let previousEdges = -1;
			for (let round = 0; round < 3; round++) {
				seq++;
				fs.appendFileSync(
					changed,
					`\nexport const marker${round} = ${round};\n`,
				);
				clearGraphCache();
				const graph = await buildOrUpdateGraph(
					root,
					[changed],
					new FactStore(),
					seqHint,
				);
				// Mutation guard for the dedupe branch in restoreValidIncomingEdges:
				// dropping it re-appends the preserved incoming edges every round, so
				// the edge count climbs instead of holding steady.
				const keys = graph.edges.map((edge) =>
					JSON.stringify([edge.from, edge.to, edge.kind, edge.metadata ?? {}]),
				);
				expect(new Set(keys).size).toBe(keys.length);
				if (previousEdges >= 0) expect(graph.edges.length).toBe(previousEdges);
				previousEdges = graph.edges.length;
			}
		},
	);
});
