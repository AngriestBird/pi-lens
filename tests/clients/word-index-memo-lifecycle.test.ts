/**
 * #4124: the serialized word-index memo is also what makes a persist
 * incremental (#2068, #2202). It is kept across a run's persists, released at
 * `agent_settled`, and bounded by a stalled-run backstop. Fake timers drive the
 * backstop; the settle itself is exercised through `index.ts` in
 * `tests/index-word-index-memo-settle.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecentLoggedPhases } from "../../clients/latency-logger.js";
import {
	buildWordIndex,
	deserializeWordIndex,
	getLastWordIndexSerializeWork,
	releaseWordIndexMemoAtSettle,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";

describe("word-index serialized memo lifecycle (#4124)", () => {
	const threeFiles = [
		{ path: "src/a.ts", content: "function alphaHandler() {}" },
		{ path: "src/b.ts", content: "function betaHandler(alpha) {}" },
		{ path: "src/c.ts", content: "function gammaHandler() {}" },
	];

	/**
	 * Whether the NEXT persist of an unchanged index is served from the memo.
	 * Destructive on purpose: serializing re-creates (and re-arms) the memo, so
	 * this is the last observation of a case.
	 */
	function memoServesNextSerialize(index: ReturnType<typeof buildWordIndex>) {
		serializeWordIndex(index);
		return getLastWordIndexSerializeWork()?.tookFullPath === false;
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("keeps the memo across a run's persists and drops it at settle, leaving the decoded index live", () => {
		const index = buildWordIndex(threeFiles);
		serializeWordIndex(index);
		updateWordIndexDocument(index, {
			path: "src/a.ts",
			content: "function alphaHandler() { changedMarker(); }",
		});
		// Recurrence: #4124's first round released the memo after every
		// publication, so each later edit's persist was a full re-serialize
		// (affectedTokenCount 59,182 on this repo) instead of O(dirty tokens).
		serializeWordIndex(index);
		expect(getLastWordIndexSerializeWork()).toMatchObject({
			tookFullPath: false,
		});
		expect(getLastWordIndexSerializeWork()?.affectedTokenCount).toBeLessThan(
			10,
		);

		releaseWordIndexMemoAtSettle(index);

		expect(memoServesNextSerialize(index)).toBe(false);
		expect(searchWordIndex(index, "alpha handler").map((r) => r.file)).toEqual(
			expect.arrayContaining(["src/a.ts", "src/b.ts"]),
		);
	});

	it("logs one row when a held memo is released and none when nothing is held", () => {
		const index = buildWordIndex(threeFiles);
		const rows = () =>
			getRecentLoggedPhases().filter(
				(entry) => entry.phase === "word_index_memo_released",
			);
		const before = rows().length;
		releaseWordIndexMemoAtSettle(index);
		expect(rows()).toHaveLength(before);

		serializeWordIndex(index);
		releaseWordIndexMemoAtSettle(index);
		releaseWordIndexMemoAtSettle(index);
		expect(rows()).toHaveLength(before + 1);
		expect(rows()[0].metadata).toEqual({ trigger: "settle", files: 3 });
	});

	it("releases a stalled run's memo after the 10 minute default backstop", () => {
		vi.useFakeTimers();
		const held = buildWordIndex(threeFiles);
		serializeWordIndex(held);
		vi.advanceTimersByTime(10 * 60_000 - 1);
		expect(memoServesNextSerialize(held)).toBe(true);

		const stalled = buildWordIndex(threeFiles);
		serializeWordIndex(stalled);
		vi.advanceTimersByTime(10 * 60_000);
		expect(memoServesNextSerialize(stalled)).toBe(false);
		expect(
			getRecentLoggedPhases().find(
				(entry) => entry.phase === "word_index_memo_released",
			)?.metadata,
		).toEqual({ trigger: "backstop", files: 3 });
	});

	it("honors PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS and re-arms it on every serialize", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", "1000");
		const index = buildWordIndex(threeFiles);
		serializeWordIndex(index);
		vi.advanceTimersByTime(800);
		serializeWordIndex(index);
		// 1,600 ms after the first serialize but 800 ms after the re-arm.
		vi.advanceTimersByTime(800);
		expect(memoServesNextSerialize(index)).toBe(true);

		const idle = buildWordIndex(threeFiles);
		serializeWordIndex(idle);
		vi.advanceTimersByTime(1000);
		expect(memoServesNextSerialize(idle)).toBe(false);
	});

	it("also bounds the memo seeded by a snapshot load, which no serialize armed", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", "1000");
		// Recurrence: a session that loads the persisted index and never edits
		// held the loaded wire form for its whole life.
		const loaded = deserializeWordIndex(
			serializeWordIndex(buildWordIndex(threeFiles)),
		)!;
		vi.advanceTimersByTime(1000);
		expect(memoServesNextSerialize(loaded)).toBe(false);
	});
});
