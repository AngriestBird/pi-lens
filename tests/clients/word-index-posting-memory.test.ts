/**
 * #2069 — the word index's resident footprint.
 *
 * The index used to hold one boxed `{ file, line }` object per (token, file,
 * line) posting: 2.22 million objects for a 17.9 MB corpus, measured at
 * 186.6 MB resident, or 88.1 bytes to carry eight bytes of information. The fix
 * packs postings and the forward index into `Int32Array` lanes over a dense
 * file-id space.
 *
 * The first test here is the acceptance guard and measures REAL retained heap
 * with a forced collection on both sides, because an arithmetic estimate cannot
 * catch a representation that quietly reboxes. Everything else is a
 * mutation guard for one specific mechanism the packed form depends on.
 *
 * On pre-fix code every measured assertion below fails: the boxed
 * representation costs about 90 bytes per entry on this fixture, and
 * `word-index-store.js` does not exist.
 */

import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	countWordIndexPostingEntries,
	estimateWordIndexResidentBytes,
	removeWordIndexDocument,
	searchWordIndex,
	updateWordIndexDocument,
	wordIndexKey,
	wordIndexPostingHits,
	type WordIndex,
} from "../../clients/word-index.js";
import {
	countPostingBackingStores,
	WORD_POSTING_ENTRY_BYTES,
} from "../../clients/word-index-store.js";

/**
 * Ceiling on measured bytes per posting entry.
 *
 * The fixture below measures 17.8 on a packed index and 97.2 on the boxed one,
 * so 28 leaves ~57% headroom for host variation while still failing hard on
 * the boxed representation. It is also tight enough to catch dropping the
 * token canonicalization the forward index depends on, which costs one string
 * per (document, token) and measured 39 bytes per entry on this fixture.
 *
 * #2069's own "under 16" is a figure for the real 2,622-document corpus, where
 * fixed per-token costs amortize over far more postings. That criterion is
 * asserted separately against the deterministic estimate.
 */
const MEASURED_BYTES_PER_ENTRY_CEILING = 28;

/**
 * A vocabulary sized so the fixture's postings-per-token ratio resembles a real
 * source tree's. That ratio is what the per-entry figure is sensitive to: the
 * fixed per-token bookkeeping amortizes over a token's postings, so a corpus of
 * mostly once-used identifiers reports a much higher per-entry cost than
 * pi-lens's own tree (2.26 million postings over 37,500 tokens, about 60 each).
 * 2,400 identifiers over the corpus below lands in the same neighbourhood.
 */
const VOCABULARY = Array.from({ length: 2400 }, (_, i) => `symbolName${i}`);

/** Deterministic pseudo-random source: the fixture must not vary run to run. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function makeCorpus(documents: number, lines: number) {
	const random = makeRandom(20690);
	return Array.from({ length: documents }, (_, doc) => ({
		path: `src/module${doc}/file${doc}.ts`,
		content: Array.from({ length: lines }, () => {
			const words = Array.from(
				{ length: 4 },
				() => VOCABULARY[Math.floor(random() * VOCABULARY.length)],
			);
			return `const ${words[0]} = ${words[1]}(${words[2]}, ${words[3]});`;
		}).join("\n"),
	}));
}

function forceCollection(): void {
	const collect = globalThis.gc;
	// Assert rather than skip: without --expose-gc (vitest.config.ts's
	// `execArgv`) this file cannot measure anything, and a silent skip would
	// leave the acceptance guard disarmed with a green tick (AGENTS.md shape 7 /
	// the invisible-skip test-authoring screen).
	expect(typeof collect).toBe("function");
	for (let i = 0; i < 5; i += 1) (collect as () => void)();
}

/** Retained bytes, heap plus external backing stores, after a forced collection. */
function retainedBytes(): number {
	forceCollection();
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

describe("word-index posting footprint (#2069)", () => {
	it("holds a built index well under the boxed representation's cost", () => {
		const corpus = makeCorpus(240, 220);

		const before = retainedBytes();
		const index = buildWordIndex(corpus);
		const after = retainedBytes();

		const entries = countWordIndexPostingEntries(index);
		expect(entries).toBeGreaterThan(150_000);

		const measuredPerEntry = (after - before) / entries;
		// Keep the index reachable across the sample, then report on failure.
		expect(index.docCount).toBe(corpus.length);
		expect(measuredPerEntry).toBeLessThan(MEASURED_BYTES_PER_ENTRY_CEILING);
	});

	it("estimates under 16 bytes per posting entry (#2069 acceptance criterion 2)", () => {
		const index = buildWordIndex(makeCorpus(240, 220));
		const entries = countWordIndexPostingEntries(index);
		expect(entries).toBeGreaterThan(150_000);
		// Pin the density this figure is sensitive to, so a fixture edit that
		// quietly makes the corpus sparser cannot turn the bound into a fluke.
		expect(entries / index.postings.size).toBeGreaterThan(20);
		expect(estimateWordIndexResidentBytes(index) / entries).toBeLessThan(16);
	});

	it("leaves no growth slack in a bulk-built posting list", () => {
		const index = buildWordIndex(makeCorpus(40, 60));
		for (const list of index.postings.values()) {
			// `compact()` ran, so capacity equals length exactly. Drop the compaction
			// pass and the doubling growth leaves up to 100% slack here.
			expect(list.byteLength).toBe(list.length * WORD_POSTING_ENTRY_BYTES);
		}
	});

	it("shares one backing store across every bulk-built posting list", () => {
		const index = buildWordIndex(makeCorpus(40, 60));
		expect(index.postings.size).toBeGreaterThan(20);
		// Drop the arena pass and this equals `postings.size`: one ArrayBuffer
		// header per token, which measured 2.5 MB on this repository's corpus.
		expect(countPostingBackingStores(index.postings)).toBe(1);
		// A representation with no packed lanes at all reports one distinct
		// backing store too, because every list would report `undefined`. Pin the
		// store's identity and width so that cannot pass for an arena.
		const [first] = [...index.postings.values()];
		expect(first.backingStore).toBeInstanceOf(Int32Array);
		expect(first.backingStore.length).toBe(
			countWordIndexPostingEntries(index) * 2,
		);
	});

	it("moves a token that outgrows its arena slice without disturbing its neighbours", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "alphaToken\nbetaToken" },
			{ path: "b.ts", content: "betaToken\ngammaToken" },
		]);
		expect(countPostingBackingStores(index.postings)).toBe(1);
		const alphaBefore = wordIndexPostingHits(index, "alphatoken");
		const betaBefore = wordIndexPostingHits(index, "betatoken");
		const gammaBefore = wordIndexPostingHits(index, "gammatoken");

		// `gammatoken` is the LAST list in the arena, so its slice starts at a
		// non-zero offset — the case that catches a grow which forgets to reset
		// the offset as well as one that writes past the slice. Growing the FIRST
		// list would sit at offset zero and pass either way.
		updateWordIndexDocument(index, {
			path: "c.ts",
			content: "gammaToken\ngammaToken more",
		});

		expect(wordIndexPostingHits(index, "gammatoken")).toHaveLength(3);
		expect(wordIndexPostingHits(index, "alphatoken")).toEqual(alphaBefore);
		expect(wordIndexPostingHits(index, "betatoken")).toEqual(betaBefore);
		expect(wordIndexPostingHits(index, "gammatoken").slice(0, 1)).toEqual(
			gammaBefore,
		);
	});

	it("recycles the file id a replaced document releases", () => {
		const index = buildWordIndex([{ path: "a.ts", content: "alphaToken" }]);
		for (let i = 0; i < 50; i += 1) {
			updateWordIndexDocument(index, {
				path: "a.ts",
				content: `alphaToken revision${i}`,
			});
		}
		expect(index.fileTable.size).toBe(1);
		// Without the free list, each replacement's remove-then-add would burn a
		// fresh id and strand a display-path slot: 51 slots for one document.
		expect(index.fileTable.idSpaceWidth).toBe(1);
	});

	it("does not let a recycled file id alias a removed document's postings", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "sharedToken alphaOnly" },
			{ path: "b.ts", content: "sharedToken betaOnly" },
		]);
		const removedId = index.fileTable.idFor(wordIndexKey("a.ts"));
		expect(removedId).toBeDefined();
		expect(removeWordIndexDocument(index, "a.ts")).toBe(true);

		// The next document interned takes the recycled id.
		expect(
			updateWordIndexDocument(index, {
				path: "c.ts",
				content: "sharedToken gammaOnly",
			}),
		).toBe(true);
		expect(index.fileTable.idFor(wordIndexKey("c.ts"))).toBe(removedId);

		// a.ts must be gone from every posting the recycled id could alias.
		const files = wordIndexPostingHits(index, "sharedtoken").map(
			(hit) => hit.file,
		);
		expect(files.sort()).toEqual(["b.ts", "c.ts"]);
		expect(index.postings.has("alphaonly")).toBe(false);
	});

	it("ranks identically to the boxed representation's documented output", () => {
		// #2069 acceptance criterion 3: file/score/hits/lines are unchanged. The
		// packed store groups by file id and resolves the display path once per
		// (token, file); this pins the resolved output shape.
		const index: WordIndex = buildWordIndex([
			{ path: "src/widget.ts", content: "renderWidget\nrenderWidget helper" },
			{ path: "src/other.ts", content: "renderWidget" },
		]);
		const results = searchWordIndex(index, "renderWidget", {
			demoteTestVendor: false,
			demoteDocs: false,
		});
		expect(
			results.map((r) => ({ file: r.file, hits: r.hits, lines: r.lines })),
		).toEqual([
			// `renderWidget` splits into three query tokens (renderwidget,
			// render, widget), so `hits` is the summed term frequency across all
			// three, not the count of matching lines.
			{ file: "src/widget.ts", hits: 6, lines: [1, 2] },
			{ file: "src/other.ts", hits: 3, lines: [1] },
		]);
	});
});
