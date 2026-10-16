/**
 * #4484 round 3 (R2): where a recorded blocker's line sits after a write.
 *
 * Recurrence it prevents: the carry matched a recorded blocker by identity
 * alone, so after an edit an untouched occurrence of the same rule stood in
 * for the fixed one (review F1, probes P9/P10). The carry now maps the
 * recorded line through this alignment; a wrong map would keep a fixed
 * blocker or retire a moved one.
 */
import { describe, expect, it } from "vitest";
import {
	alignLines,
	lineHashesOf,
	linesOfRanges,
	MAX_ALIGNMENT_LINES,
	MAX_OWED_RANGES,
	owedRangesAfterDispatch,
	rangesOfLines,
} from "../../clients/line-alignment.js";

const hashes = (text: string) => {
	const h = lineHashesOf(text);
	if (!h) throw new Error("no hashes");
	return h;
};
const map = (before: string, after: string, maxEdits?: number) =>
	alignLines(hashes(before), hashes(after), maxEdits);

describe("alignLines", () => {
	it("maps unchanged files line for line", () => {
		const m = map("a\nb\nc\n", "a\nb\nc\n");
		expect([1, 2, 3, 4].map((l) => m?.(l))).toEqual([1, 2, 3, 4]);
	});

	it("shifts lines below an inserted line", () => {
		const m = map("a\nb\nc\n", "x\na\nb\nc\n");
		expect([1, 2, 3].map((l) => m?.(l))).toEqual([2, 3, 4]);
	});

	it("maps an edited line nowhere and keeps its neighbours", () => {
		const m = map("a\nb\nc\n", "a\nB\nc\n");
		expect([1, 2, 3].map((l) => m?.(l))).toEqual([1, undefined, 3]);
	});

	it("maps a deleted line nowhere and pulls the rest up", () => {
		const m = map("a\nb\nc\nd\n", "a\nc\nd\n");
		expect([1, 2, 3, 4].map((l) => m?.(l))).toEqual([1, undefined, 2, 3]);
	});

	it("aligns several hunks at once", () => {
		const m = map("a\nb\nc\nd\ne\nf\n", "a\nX\nb\nc\nE\nf\ng\n");
		expect([1, 2, 3, 4, 5, 6].map((l) => m?.(l))).toEqual([
			1,
			3,
			4,
			undefined,
			undefined,
			6,
		]);
	});

	// Two identical lines (two occurrences of one rule): the one the edit
	// changed maps nowhere, the untouched one keeps its own place.
	it("tells two identical lines apart by the edit between them", () => {
		const twin = "f(): unknown {\n";
		const m = map(`${twin}x\n${twin}`, `${twin}x\nf(): string {\n`);
		expect(m?.(1)).toBe(1);
		expect(m?.(3)).toBeUndefined();
	});

	it("treats a whitespace-only change as the same line", () => {
		const m = map("a\n\tb\n", "a\n    b\n");
		expect(m?.(2)).toBe(2);
	});

	it("has no alignment once the change exceeds the edit cap", () => {
		expect(map("a\nb\nc\n", "x\ny\nz\n", 2)).toBeUndefined();
		expect(map("a\nb\nc\n", "x\ny\nz\n", 6)?.(1)).toBeUndefined();
	});

	it("maps lines outside the old file nowhere", () => {
		const m = map("a\n", "a\n");
		expect(m?.(0)).toBeUndefined();
		expect(m?.(3)).toBeUndefined();
	});
});

// Round 4 (G3): the anchor lived in a cache bounded by count only. It now
// sits on the blocker record; this pins its size per record.
describe("anchor size", () => {
	it("keeps 4 bytes per line, and nothing past the line cap", () => {
		const text = "x\n".repeat(MAX_ALIGNMENT_LINES - 1);
		expect(lineHashesOf(text)?.byteLength).toBe(4 * MAX_ALIGNMENT_LINES);
		expect(lineHashesOf(`${text}x\n`)).toBeUndefined();
	});
});

describe("ranges and lines", () => {
	it("round-trips owed lines through merged ranges", () => {
		const ranges = rangesOfLines([7, 3, 4, 9, 8, 3]);
		expect(ranges).toEqual([
			{ start: 3, end: 4 },
			{ start: 7, end: 9 },
		]);
		expect(linesOfRanges(ranges)).toEqual([3, 4, 7, 8, 9]);
	});
});

// R4. Recurrences: a runner with no verdict owed nothing, so a blocker first
// written then was withheld as out of range forever (TLC MutOwedRanges); and
// a collect-later runner, in flight on every write, would owe every edited
// line for good and widen each later edit's range.
describe("owedRangesAfterDispatch", () => {
	const owed = new Map([["ast-grep-napi", [{ start: 9, end: 9 }]]]);
	const run = (over: Partial<Parameters<typeof owedRangesAfterDispatch>[0]>) =>
		owedRangesAfterDispatch({
			noVerdict: [],
			collectLater: [],
			modifiedRanges: [{ start: 3, end: 4 }],
			owed,
			lineCount: () => 12,
			delivers: true,
			...over,
		});

	it("owes a runner without a verdict the edit's range and its earlier owed lines", () => {
		expect(run({ noVerdict: ["ast-grep-napi", "eslint"] })).toEqual(
			new Map([
				[
					"ast-grep-napi",
					[
						{ start: 3, end: 4 },
						{ start: 9, end: 9 },
					],
				],
				["eslint", [{ start: 3, end: 4 }]],
			]),
		);
	});

	it("owes the whole file after a dispatch without a range", () => {
		expect(
			run({ noVerdict: ["eslint"], modifiedRanges: undefined }).get("eslint"),
		).toEqual([{ start: 1, end: 12 }]);
	});

	it("owes nothing to a runner still in flight or one with a verdict", () => {
		expect(run({ noVerdict: ["lsp"], collectLater: ["lsp"] }).size).toBe(0);
		expect(run({}).size).toBe(0);
	});

	// Recurrence: an unauthored run (#3226) withholds the blocker channel, yet
	// its verdict discharged the owed lines, so the blocker they held was
	// never delivered or recorded (TLC MutOwedRanges via the opaque step).
	it("keeps every earlier owed line after a run that may not deliver", () => {
		expect(run({ delivers: false }).get("ast-grep-napi")).toEqual([
			{ start: 9, end: 9 },
		]);
	});

	// Round 4 (G3): owed ranges grew with every write that lacked a verdict.
	it("owes the whole file once a runner's owed ranges pass the cap", () => {
		const scattered = Array.from({ length: MAX_OWED_RANGES + 1 }, (_, i) => ({
			start: 2 * i + 1,
			end: 2 * i + 1,
		}));
		expect(
			run({
				noVerdict: ["eslint"],
				modifiedRanges: scattered,
				lineCount: () => 500,
			}).get("eslint"),
		).toEqual([{ start: 1, end: 500 }]);
		expect(
			run({
				noVerdict: ["eslint"],
				modifiedRanges: scattered.slice(0, MAX_OWED_RANGES),
			}).get("eslint"),
		).toHaveLength(MAX_OWED_RANGES);
	});
});
