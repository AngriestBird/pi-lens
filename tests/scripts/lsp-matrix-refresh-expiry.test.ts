/**
 * #3401 — the expiry and hysteresis guards on `docs/lsp-capability-matrix.md`'s
 * probe-owned cells.
 *
 * ## The recurrence this guards
 *
 * `probe-clean-signal.mjs`'s merge guard preserves a cell the current run did
 * not measure, so an ubuntu-poor nightly cannot regress a richer dev-box row
 * (#390). But "not measured" is also how a stale value hides: the vue and
 * ast-grep `first-publish=direct` cells were produced by the pre-#3394
 * attribution defect, and once the corrected probe observed NOTHING on that
 * axis the guard kept them forever — a dead instrument and a healthy one look
 * identical when non-results are discarded by design (the #3310 lesson).
 *
 * A second shape is a flap: ast-grep's `clean-behavior` went 2 → 2* → 3 → 2*
 * across four nightlies, so any single run could rewrite a tier. The fix holds
 * a change as `pending` until `TIER_CHANGE_AGREE_RUNS` consecutive runs agree.
 *
 * Both need an observation memory that outlives one nightly. The matrix doc is
 * the only state the refresh persists (the `bot/lsp-docs-refresh` auto-PR
 * commits it, and `check-generated-docs-diff.mjs` opens the PR when it
 * changes), so the counters live in a generated section of that same doc. These
 * tests drive the real refresh entry, `refreshCapabilityMatrix`, with recorded
 * run inputs and no LSP spawn.
 */
import { describe, expect, it } from "vitest";
import {
	FIRST_PUBLISH_EXPIRY_RUNS,
	TIER_CHANGE_AGREE_RUNS,
	mergeRows,
	parseRefreshState,
	parseTable,
	refreshCapabilityMatrix,
	replaceTable,
	type MatrixObservation,
} from "../../scripts/lib/md-matrix.mjs";

const MARKER = "| lang | server |";

const FIXTURE = [
	"# LSP capability matrix",
	"",
	"| lang | server | mode | clean-behavior | first-publish | tier | src |",
	"|---|---|---|---|---|---|---|",
	"| vue | @vue/language-server | push-only | unknown | direct | 2/3? | dev+ci |",
	"| ast-grep | ast-grep (aux) | push-only | publishes-versioned | direct | 2 | dev+ci |",
	"| rust | rust-analyzer | pull | — | n/a (pull) | 1 | dev+ci |",
	"",
	"## Key findings",
	"",
	"Prose after the table must survive the refresh.",
	"",
].join("\n");

/** Read one cell from the fixture matrix by lang + header name. */
function cellOf(
	text: string,
	lang: string,
	column: string,
): string | undefined {
	const table = parseTable(text, MARKER);
	if (!table) return undefined;
	const langIdx = table.header.indexOf("lang");
	const colIdx = table.header.indexOf(column);
	if (langIdx < 0 || colIdx < 0) return undefined;
	for (const cells of table.rows) {
		if (cells[langIdx] === lang) return cells[colIdx];
	}
	return undefined;
}

/**
 * A classified observation, as the probe hands it to the refresh entry: an axis
 * the run did not observe comparably is `null` (the expiry population), and a
 * measured clean-behavior carries the tier the writer should record with it.
 */
function observation(
	lang: string,
	overrides: Partial<MatrixObservation> = {},
): MatrixObservation {
	return {
		lang,
		cleanBehavior: null,
		firstPublish: null,
		tier: null,
		...overrides,
	};
}

/** A recorded run input that measured both axes. */
function measured(
	lang: string,
	cleanBehavior: string,
	tier: string,
): MatrixObservation {
	return observation(lang, {
		cleanBehavior,
		tier,
		firstPublish: "direct",
	});
}

describe("#3401 first-publish expiry", () => {
	it("preserves a stale first-publish cell through the plain merge guard (the pre-fix defect)", () => {
		// The pre-fix production path: the merge guard writes only the columns a
		// run measured, so a run with no first-publish observation leaves the
		// stale `direct` in place. This is the behavior the expiry must end.
		const table = parseTable(FIXTURE, MARKER)!;
		const merged = mergeRows(
			table.rows,
			table.header,
			[{ lang: "vue", src: "ci" }],
			"lang",
			["clean-behavior", "first-publish", "tier", "src"],
			{ updateOnly: true },
		);
		const preFix = replaceTable(
			FIXTURE,
			MARKER,
			table.header,
			table.sep,
			merged,
		)!;
		expect(cellOf(preFix, "vue", "first-publish")).toBe("direct");
	});

	it("keeps the stale cell until the bound, then expires it to unknown", () => {
		let text = FIXTURE;
		for (let run = 1; run < FIRST_PUBLISH_EXPIRY_RUNS; run++) {
			text = refreshCapabilityMatrix(text, [], { src: "ci" }).text;
			expect(
				cellOf(text, "vue", "first-publish"),
				`run ${run} of ${FIRST_PUBLISH_EXPIRY_RUNS} must still hold the measured cell`,
			).toBe("direct");
		}
		const final = refreshCapabilityMatrix(text, [], { src: "ci" });
		expect(cellOf(final.text, "vue", "first-publish")).toBe("unknown");
		expect(cellOf(final.text, "ast-grep", "first-publish")).toBe("unknown");
		expect(final.expired).toBeGreaterThanOrEqual(2);
	});

	it("resets the miss streak when the axis is observed again", () => {
		const observed = observation("vue", { firstPublish: "direct" });
		let text = FIXTURE;
		// Three misses, then a fresh observation must clear the counter.
		for (let run = 0; run < 3; run++)
			text = refreshCapabilityMatrix(text, [], { src: "ci" }).text;
		expect(parseRefreshState(text)["first-publish"]?.vue?.missed).toBe(3);
		text = refreshCapabilityMatrix(text, [observed], { src: "ci" }).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toBeUndefined();
		// The bound is measured in CONSECUTIVE misses, so re-arming starts over.
		for (let run = 1; run < FIRST_PUBLISH_EXPIRY_RUNS; run++)
			text = refreshCapabilityMatrix(text, [], { src: "ci" }).text;
		expect(cellOf(text, "vue", "first-publish")).toBe("direct");
	});

	it("never expires a pull row's n/a (pull) cell", () => {
		let text = FIXTURE;
		for (let run = 0; run < FIRST_PUBLISH_EXPIRY_RUNS + 2; run++)
			text = refreshCapabilityMatrix(text, [], { src: "ci" }).text;
		expect(cellOf(text, "rust", "first-publish")).toBe("n/a (pull)");
		expect(parseRefreshState(text)["first-publish"]?.rust).toBeUndefined();
	});
});

describe("#3401 clean-behavior hysteresis", () => {
	it("writes a change only after TIER_CHANGE_AGREE_RUNS agreeing runs", () => {
		expect(TIER_CHANGE_AGREE_RUNS).toBe(2);
		const rows = [measured("ast-grep", "publishes-unversioned", "2*")];
		const first = refreshCapabilityMatrix(FIXTURE, rows, { src: "ci" });
		expect(cellOf(first.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
		expect(first.pending).toBe(1);
		expect(first.committed).toBe(0);
		const second = refreshCapabilityMatrix(first.text, rows, { src: "ci" });
		expect(cellOf(second.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-unversioned",
		);
		expect(cellOf(second.text, "ast-grep", "tier")).toBe("2*");
		expect(second.committed).toBe(1);
	});

	it("holds the ast-grep 2 -> 2* -> 3 -> 2* flap without a single-run rewrite", () => {
		// The recorded nightly sequence the #3443 investigation found. No run
		// alone may move the cell; only two consecutive runs of the SAME value can.
		const sequence = [
			measured("ast-grep", "publishes-unversioned", "2*"),
			measured("ast-grep", "silent", "3"),
			measured("ast-grep", "publishes-unversioned", "2*"),
			measured("ast-grep", "silent", "3"),
		];
		let text = FIXTURE;
		for (const row of sequence) {
			const result = refreshCapabilityMatrix(text, [row], { src: "ci" });
			text = result.text;
			expect(result.committed).toBe(0);
			expect(cellOf(text, "ast-grep", "clean-behavior")).toBe(
				"publishes-versioned",
			);
			expect(cellOf(text, "ast-grep", "tier")).toBe("2");
		}
	});

	it("breaks a held change when an intervening run observes something else", () => {
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		const b = measured("ast-grep", "silent", "3");
		let text = refreshCapabilityMatrix(FIXTURE, [a], { src: "ci" }).text;
		text = refreshCapabilityMatrix(text, [b], { src: "ci" }).text;
		// A second `a` would have committed under the first hold; the intervening
		// `b` reset it, so this is a first sighting again.
		const third = refreshCapabilityMatrix(text, [a], { src: "ci" });
		expect(third.committed).toBe(0);
		expect(cellOf(third.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
	});

	it("clears a held change when the cell already matches", () => {
		const change = measured("ast-grep", "publishes-unversioned", "2*");
		const steady = measured("ast-grep", "publishes-versioned", "2");
		let text = refreshCapabilityMatrix(FIXTURE, [change], { src: "ci" }).text;
		expect(
			parseRefreshState(text)["clean-behavior"]?.["ast-grep"],
		).toBeDefined();
		text = refreshCapabilityMatrix(text, [steady], { src: "ci" }).text;
		expect(
			parseRefreshState(text)["clean-behavior"]?.["ast-grep"],
		).toBeUndefined();
		// Re-observing the change must now be a fresh first sighting, not a commit.
		const again = refreshCapabilityMatrix(text, [change], { src: "ci" });
		expect(again.committed).toBe(0);
	});
});

describe("#3401 refresh state block", () => {
	it("records a state-only change so the refresh PR can persist it", () => {
		const result = refreshCapabilityMatrix(FIXTURE, [], { src: "ci" });
		expect(result.changed).toBe(true);
		expect(result.expired).toBe(0);
		expect(parseRefreshState(result.text)["first-publish"]?.vue?.missed).toBe(
			1,
		);
	});

	it("is byte-stable when every measured cell already matches", () => {
		const steady = [
			measured("ast-grep", "publishes-versioned", "2"),
			observation("vue", { firstPublish: "direct" }),
		];
		const first = refreshCapabilityMatrix(FIXTURE, steady, { src: "ci" });
		expect(first.changed).toBe(false);
		const second = refreshCapabilityMatrix(first.text, steady, { src: "ci" });
		expect(second.text).toBe(first.text);
	});

	it("round-trips the state block and treats an absent or corrupt block as empty", () => {
		const text = refreshCapabilityMatrix(FIXTURE, [], { src: "ci" }).text;
		expect(parseRefreshState(text)["first-publish"]?.vue?.missed).toBe(1);
		// A second pass parses what the first wrote and advances the counter.
		expect(
			parseRefreshState(refreshCapabilityMatrix(text, [], { src: "ci" }).text)[
				"first-publish"
			]?.vue?.missed,
		).toBe(2);
		expect(parseRefreshState("# no state block\n")).toEqual({});
		expect(
			parseRefreshState(
				"## Capability matrix refresh state (nightly-generated)\n\n```json\n{not json\n```\n",
			),
		).toEqual({});
	});

	it("reports a missing capability table instead of crashing", () => {
		const result = refreshCapabilityMatrix("# no table here\n", []);
		expect(result.changed).toBe(false);
		expect(result.reason).toMatch(/capability table/);
	});
});
