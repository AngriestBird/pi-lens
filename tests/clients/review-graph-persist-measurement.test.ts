/**
 * #3913 measured-constant pin (#3648): the decision NOT to ship a byte transfer
 * for the review graph's persist sites rests on the raw output of
 * `scripts/bench-review-graph-persist.mjs`, kept in
 * `tests/fixtures/review-graph-persist-measurement/`. The `before-*` rounds are
 * the shipped structured-clone code (ca7e89066); the `after-*` rounds are the
 * byte-transfer tree e9dcfaba7, kept in history only. At the persist site
 * stringify plus encode on the main thread cost about twice the clone they
 * would replace, which trips the pre-registered rule. Nothing here records a
 * shipped gain.
 *
 * This file reads the artifacts; it never re-measures (a wall-clock assertion
 * on a shared runner would flake). It pins their provenance and the verdict the
 * bench header's materiality rule gives them, not the code.
 *
 * Recurrences this prevents:
 *  - a hand-edited or stale artifact whose summary no longer follows from its
 *    own raw runs;
 *  - the two trees measured on different inputs;
 *  - the verdict drifting from the rule fixed before the first measurement.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Run {
	isBytes: boolean;
	stringifyMs: number;
	mainThreadMs: number;
	rssJumpMB: number;
	jsonChars?: number;
}
interface Result {
	site: "persist" | "checkpoint" | "checkpoint-control";
	fileCount: number;
	elements: number;
	runs: Run[];
	summary: {
		medianMainThreadMs?: number;
		maxMainThreadMs?: number;
		medianRssJumpMB?: number;
		maxRssJumpMB?: number;
	};
}
interface Round {
	label: string;
	command: string;
	results: Result[];
}

const read = (name: string): Round =>
	JSON.parse(
		readFileSync(
			resolve(
				import.meta.dirname,
				"../fixtures/review-graph-persist-measurement",
				name,
			),
			"utf-8",
		),
	) as Round;
const before = [1, 2, 3].map((n) => read(`before-${n}.json`));
const after = [1, 2, 3].map((n) => read(`after-${n}.json`));

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const site = (round: Round, name: Result["site"]) => {
	const found = round.results.find((result) => result.site === name);
	if (!found) throw new Error(`round ${round.label} has no ${name} result`);
	return found;
};
/** The bench header's rule: more than 1.5x the before median AND more than
 * 100 ms above it. */
const fires = (afterMs: number, beforeMs: number) =>
	afterMs > beforeMs * 1.5 && afterMs - beforeMs > 100;

describe("review-graph persist measurement artifacts, transfer not shipped (#3913)", () => {
	it("holds three rounds per tree from one command on one input", () => {
		for (const [rounds, label] of [
			[before, "before"],
			[after, "after"],
		] as const) {
			for (const round of rounds) {
				expect(round.label).toBe(label);
				expect(round.command).toBe(
					"node scripts/bench-review-graph-persist.mjs --sites persist,checkpoint,checkpoint-control --files 5000 --persists 5",
				);
				expect(round.results.map((result) => result.site)).toEqual([
					"persist",
					"checkpoint",
					"checkpoint-control",
				]);
				for (const result of round.results) {
					expect(result.fileCount).toBe(5000);
					expect(result.elements).toBe(374_989);
				}
			}
		}
		// The bytes tree serializes the same graph every persist, give or take the
		// timestamp's digits: one 160 MB body.
		const bodies = after.flatMap((round) =>
			site(round, "persist").runs.map((run) => run.jsonChars ?? 0),
		);
		expect(Math.min(...bodies)).toBeGreaterThan(160_400_000);
		expect(Math.max(...bodies)).toBeLessThan(160_600_000);
		expect(
			[...before, ...after].every((round) =>
				site(round, "persist").runs.every(
					(run) => run.isBytes === (round.label === "after"),
				),
			),
		).toBe(true);
	});

	it("derives every committed summary from its own raw runs", () => {
		for (const round of [...before, ...after]) {
			for (const result of round.results) {
				if (result.runs.length === 0) continue;
				// The bench rounds to one decimal, so an even-count median can land
				// 0.05 off the exact midpoint; compare to the nearest 0.5.
				expect(result.summary.medianMainThreadMs).toBeCloseTo(
					median(result.runs.map((run) => run.mainThreadMs)),
					0,
				);
				expect(result.summary.maxMainThreadMs).toBeCloseTo(
					Math.max(...result.runs.map((run) => run.mainThreadMs)),
					1,
				);
				expect(result.summary.medianRssJumpMB).toBeCloseTo(
					median(result.runs.map((run) => run.rssJumpMB)),
					0,
				);
				expect(result.summary.maxRssJumpMB).toBeCloseTo(
					Math.max(...result.runs.map((run) => run.rssJumpMB)),
					1,
				);
			}
		}
	});

	it("trips the rule that blocked the transfer at the persist site in every round", () => {
		for (const [index, afterRound] of after.entries()) {
			const afterMs = site(afterRound, "persist").summary.medianMainThreadMs;
			const beforeMs = site(before[index], "persist").summary
				.medianMainThreadMs;
			expect(fires(afterMs as number, beforeMs as number)).toBe(true);
		}
	});

	it("leaves the checkpoint site under the rule's absolute arm in every round", () => {
		for (const [index, afterRound] of after.entries()) {
			const afterMs = site(afterRound, "checkpoint").summary
				.medianMainThreadMs as number;
			const beforeMs = site(before[index], "checkpoint").summary
				.medianMainThreadMs as number;
			expect(afterMs / beforeMs).toBeGreaterThan(1.5);
			expect(afterMs - beforeMs).toBeLessThan(100);
			expect(fires(afterMs, beforeMs)).toBe(false);
		}
	});

	it("shows a faster encoder cannot rescue the persist site", () => {
		// The stringify alone, with the encode cost taken out, is still far above
		// the clone it replaces.
		for (const [index, afterRound] of after.entries()) {
			const stringifyMs = median(
				site(afterRound, "persist").runs.map((run) => run.stringifyMs),
			);
			const cloneMs = site(before[index], "persist").summary
				.medianMainThreadMs as number;
			expect(stringifyMs / cloneMs).toBeGreaterThan(1.4);
		}
	});

	it("shows the transfer's persist RSS gain was in the tail, not the typical persist", () => {
		for (const [index, afterRound] of after.entries()) {
			const afterSummary = site(afterRound, "persist").summary;
			const beforeSummary = site(before[index], "persist").summary;
			expect(afterSummary.maxRssJumpMB as number).toBeLessThanOrEqual(
				beforeSummary.maxRssJumpMB as number,
			);
		}
		// Rounds 2 and 3: the typical (median) jump is within 20 MB either way.
		for (const index of [1, 2]) {
			const afterMedian = site(after[index], "persist").summary
				.medianRssJumpMB as number;
			const beforeMedian = site(before[index], "persist").summary
				.medianRssJumpMB as number;
			expect(Math.abs(afterMedian - beforeMedian)).toBeLessThan(20);
		}
	});
});
