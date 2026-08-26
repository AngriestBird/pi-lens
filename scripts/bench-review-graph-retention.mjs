import assert from "node:assert/strict";
import {
	_setReviewGraphWorkspaceEntryForTests,
	clearReviewGraphWorkspaceCache,
} from "../clients/review-graph/builder.js";

const MiB = 1024 * 1024;
function graph(rebuild) {
	const nodes = new Map();
	for (let i = 0; i < 2_000; i++)
		nodes.set(`r${rebuild}-n${i}`, {
			id: `r${rebuild}-n${i}`,
			kind: "symbol",
			language: "typescript",
			filePath: `src/r${rebuild}/f${i}.ts`,
			metadata: { payload: `node-${rebuild}-${i}` },
		});
	const ids = [...nodes.keys()];
	return {
		version: "retention-test",
		builtAt: new Date().toISOString(),
		nodes,
		edges: Array.from({ length: 18_000 }, (_, i) => ({
			from: ids[i % ids.length],
			to: ids[(i * 17 + 1) % ids.length],
			kind: "references",
			metadata: { payload: `edge-${rebuild}-${i}` },
		})),
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

assert.equal(typeof globalThis.gc, "function", "run with node --expose-gc");
process.env.PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS = "1200000";
clearReviewGraphWorkspaceCache();
for (let i = 0; i < 3; i++) globalThis.gc();
const baseline = process.memoryUsage().heapUsed;
for (let i = 0; i < 20; i++)
	_setReviewGraphWorkspaceEntryForTests("retention", graph(i));
for (let i = 0; i < 3; i++) globalThis.gc();
const retained = process.memoryUsage().heapUsed - baseline;
console.log(
	`graph-cache-retention baseline=${(baseline / MiB).toFixed(1)} MiB retained=${(retained / MiB).toFixed(1)} MiB`,
);
// Pre-fix: 19 outgoing timers retained 19 graphs, measured at 74 MiB.
assert.ok(retained < 10 * MiB, `retained ${(retained / MiB).toFixed(1)} MiB`);
clearReviewGraphWorkspaceCache();
