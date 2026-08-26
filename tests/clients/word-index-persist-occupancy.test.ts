import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	getLastWordIndexSerializeWork,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";

describe("incremental word-index persist occupancy (#2068)", () => {
	it(
		"measures dirty-fraction scaling on the review fixture",
		{ timeout: 30_000 },
		() => {
			// #2202: this guard used to assert a same-run wall-clock ratio
			// (dirty=750 ms < fullMs * 1.5). A reviewer replicated it 20x under
			// 57-94% CPU load and measured a 0.436x-3.863x spread — noise wider
			// than the 2x regression the guard exists to catch, and retry: 2
			// only escapes a calibrated 2x-work injection about 2/3 of the
			// time (it biases toward the fast tail, not away from the slow
			// one). Wall clock cannot carry this assertion at any threshold.
			// The property under test — the incremental path touches
			// O(dirty-file tokens), not O(corpus tokens) — is a deterministic
			// count, so this reads it straight from serializeWordIndex's own
			// bookkeeping instead of timing it. A regression that made the
			// incremental path scan the whole corpus shows up as a count,
			// every run, independent of runner load.
			const shared = Array.from({ length: 200 }, (_, i) => `shared_${i}`).join(
				" ",
			);
			const docs = Array.from({ length: 750 }, (_, file) => ({
				path: `src/f${file}.ts`,
				content: `${shared} stable_${file}`,
			}));
			const fullIndex = buildWordIndex(docs);
			serializeWordIndex(fullIndex);
			const fullWork = getLastWordIndexSerializeWork();
			const work: Array<{
				dirty: number;
				affectedTokenCount: number;
				tookFullPath: boolean;
			}> = [];
			for (const dirty of [1, 75, 750]) {
				const index = buildWordIndex(docs);
				serializeWordIndex(index);
				for (let file = 0; file < dirty; file += 1) {
					updateWordIndexDocument(index, {
						path: `src/f${file}.ts`,
						content: `${shared} changed_${file}`,
					});
				}
				serializeWordIndex(index);
				const stats = getLastWordIndexSerializeWork();
				work.push({
					dirty,
					affectedTokenCount: stats?.affectedTokenCount ?? -1,
					tookFullPath: stats?.tookFullPath ?? true,
				});
			}
			console.log(
				JSON.stringify({
					fixture: "750-doc/200-shared-token",
					fullWork,
					work,
				}),
			);
			expect(work).toHaveLength(3);
			expect(fullWork).toBeDefined();
			const fullTokenCount = fullWork!.affectedTokenCount;
			// dirty=1 and dirty=75 stay under the >50%-dirty crossover (#2068),
			// so they must take the bounded incremental path and touch a
			// minority of the corpus's tokens, never the whole corpus.
			expect(work[0].tookFullPath).toBe(false);
			expect(work[1].tookFullPath).toBe(false);
			expect(work[0].affectedTokenCount).toBeLessThan(fullTokenCount * 0.5);
			expect(work[1].affectedTokenCount).toBeLessThan(fullTokenCount * 0.5);
			// More dirty files touch at least as many tokens, never fewer.
			expect(work[1].affectedTokenCount).toBeGreaterThanOrEqual(
				work[0].affectedTokenCount,
			);
			// dirty=750 crosses the crossover threshold and deliberately falls
			// back to a full rebuild (#2068's documented heuristic) —
			// expected, not a regression signal.
			expect(work[2].tookFullPath).toBe(true);
		},
	);

	it(
		"keeps a one-document persist below the hot-path budget at 2M postings",
		{ retry: 2, timeout: 120_000 },
		async () => {
			// 999 documents provide nearly 2M postings for 2,000 shared tokens.
			// The edited document has low-degree tokens, so the fixed path must not
			// scan the high-degree lists belonging to untouched documents.
			const shared = Array.from(
				{ length: 2_000 },
				(_, line) => `shared_${line}`,
			).join("\n");
			const docs = [
				...Array.from({ length: 999 }, (_, file) => ({
					path: `src/f${file}.ts`,
					content: shared,
				})),
				{
					path: "src/target.ts",
					content: "target_token",
				},
			];
			const index = buildWordIndex(docs);
			serializeWordIndex(index);
			updateWordIndexDocument(index, {
				path: docs[docs.length - 1].path,
				content: "changed_token",
			});

			const maxBlockMs = await measureMaxSyncBlockMs(async () => {
				serializeWordIndex(index);
			});
			// Issue #2068 measured 1,183ms before this change on 2,221,462 postings.
			// This branch measures the fixed flat incremental path at about 10ms.
			expect(maxBlockMs).toBeLessThan(50);
		},
	);
});
