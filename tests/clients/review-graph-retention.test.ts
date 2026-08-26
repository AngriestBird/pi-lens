import * as v8 from "node:v8";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	_setReviewGraphWorkspaceEntryForTests,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../clients/review-graph/types.js";

const MiB = 1024 * 1024;

function graph(rebuild: number): ReviewGraph {
	const nodes = new Map();
	for (let i = 0; i < 2_000; i += 1) {
		nodes.set(`r${rebuild}-n${i}`, {
			id: `r${rebuild}-n${i}`,
			kind: "symbol",
			language: "typescript",
			filePath: `src/r${rebuild}/f${i}.ts`,
			metadata: { payload: `node-${rebuild}-${i}` },
		});
	}
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

/**
 * A forced-collection hook without asking the whole Vitest suite for
 * `--expose-gc`. Restore the V8 flag immediately, and fail if the hook cannot
 * be exposed: a green test without its collection guard is not coverage.
 */
function resolveForcedCollector(): () => void {
	const ambient = (globalThis as { gc?: () => void }).gc;
	if (typeof ambient === "function") return ambient;
	v8.setFlagsFromString("--expose-gc");
	try {
		const collect = vm.runInNewContext("gc") as unknown;
		if (typeof collect !== "function") {
			throw new Error("could not expose gc(); #2073's memory guard cannot run");
		}
		return collect as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const forceCollect = resolveForcedCollector();

function forceCollection(): void {
	for (let i = 0; i < 3; i += 1) forceCollect();
}

describe("review-graph workspace replacement retention (#2073)", () => {
	it("does not retain replaced graph payloads through outgoing timers", () => {
		clearReviewGraphWorkspaceCache();
		forceCollection();
		const baseline = process.memoryUsage().heapUsed;

		for (let i = 0; i < 20; i += 1) {
			_setReviewGraphWorkspaceEntryForTests("retention", graph(i));
		}

		forceCollection();
		const retained = process.memoryUsage().heapUsed - baseline;
		const retainedMiB = retained / MiB;
		console.log(
			`graph-cache-retention baseline=${(baseline / MiB).toFixed(1)} MiB retained=${retainedMiB.toFixed(1)} MiB`,
		);

		// The final geometry measured about 2.7 MiB per leaked graph, so 6 MiB
		// catches one retained graph while allowing normal forced-GC variance.
		expect(retainedMiB).toBeLessThan(6);
		clearReviewGraphWorkspaceCache();
	});
});
