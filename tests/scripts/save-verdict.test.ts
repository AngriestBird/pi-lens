/**
 * Tests for the pure helpers behind `scripts/probe-save-verdict.mjs` (#3405
 * acceptance 4):
 *   - `scripts/lib/save-verdict.mjs` — the ARM classifier (which measurement arm
 *     owns the answer), the cell wording, the partial-doc merge guard and the
 *     probe ordering.
 *
 * Why these and not a live probe: the classifier is the only thing standing
 * between an arm's observation and a committed table cell, and every wrong
 * direction it could take is a silent table lie — a slow server credited to the
 * save, an unreachable toolchain blanking a measured row, a hand edit dressed as
 * a measurement. All of them are decidable from the arms, so they are pinned here
 * without spawning a language server (the same split as
 * `tests/scripts/clean-signal.test.ts`).
 */

import { describe, expect, it } from "vitest";
import {
	classifySaveVerdict,
	describeArm,
	fixturePolicy,
	orderByNeed,
	parseSaveVerdictRows,
	refreshSaveVerdictTable,
	SAVE_VERDICT_COLUMN,
	SAVE_VERDICT_MARKER,
	SAVE_VERDICT_VALUES,
	saveVerdictCells,
} from "../../scripts/lib/save-verdict.mjs";

const arm = (nonEmpty: number, ms: number | null = nonEmpty ? 100 : null) => ({
	nonEmpty,
	ms,
});

const DOC = [
	"# LSP capability matrix",
	"",
	"## Save-triggered servers: per-server verdict (#3405)",
	"",
	"| server | save as declared | publishes after save only | verdict | evidence |",
	"|---|---|---|---|---|",
	"| cpp | `save` | unknown | Unverified: not measured. | none |",
	"| cmake | `save` | unknown | Unverified: not measured. | none |",
	"| gopls | `save` | no | Source: DidSave calls didModifyFiles. | golang/tools `02c9e4c` |",
	"",
	"## Next section",
	"",
	"Untouched prose.",
	"",
].join("\n");

describe("classifySaveVerdict: which arm owns the answer (#3405)", () => {
	it("answers no when the seeded error publishes with no save", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(3, 97),
			saveAlone: arm(0),
		});
		expect(verdict.verdict).toBe("no");
		expect(verdict.reason).toContain("without a save");
	});

	it("marks a pull server's no-save answer (pull) so no publish is implied", () => {
		// A pull server never publishes; the diagnostics request answers instead.
		expect(
			classifySaveVerdict({ mode: "pull", noSave: arm(1, 210) }).verdict,
		).toBe("no (pull)");
	});

	it("answers yes only when the same bytes published after the save alone", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(0),
			saveAlone: arm(1, 233),
		});
		expect(verdict.verdict).toBe("yes");
	});

	it("credits a saved write separately, because a change rode along", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(0),
			saveAlone: arm(0),
			savedWrite: arm(2, 3400),
		});
		expect(verdict.verdict).toBe("yes (saved write)");
	});

	it("refuses to credit the save with an answer that arrived after its arm closed", () => {
		// The recurrence: a cold server publishes 9 s late, the save arm's window
		// sees it, and the row would read `yes` — a save-triggered verdict for a
		// server that simply needed more time.
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(4, null),
			saveAlone: arm(0),
		});
		expect(verdict.verdict).toBe("inconclusive");
		expect(verdict.reason).toContain("untriggered window");
	});

	it("is inconclusive — never a guessed yes — when no arm published", () => {
		expect(
			classifySaveVerdict({
				mode: "push-only",
				noSave: arm(0),
				silence: arm(0),
				saveAlone: arm(0),
				savedWrite: arm(0),
			}).verdict,
		).toBe("inconclusive");
	});

	it("treats an absent arm as silent and never as evidence of a save", () => {
		expect(classifySaveVerdict({ mode: "push-only" }).verdict).toBe(
			"inconclusive",
		);
		expect(classifySaveVerdict({}).verdict).toBe("inconclusive");
	});
});

describe("describeArm: the quoted observation", () => {
	it("names the finding count and the window length when silent", () => {
		expect(describeArm(arm(2, 97), 8000)).toBe("2 findings at 97 ms");
		expect(describeArm(arm(1, 40), 8000)).toBe("1 finding at 40 ms");
		expect(describeArm(arm(0), 8000)).toBe("silent (8000 ms)");
	});
});

describe("fixturePolicy: the clean-gate token comes from the fixture", () => {
	it("reads the harness's own declaration", () => {
		expect(fixturePolicy({ lspGate: true })).toBe("Gated.");
		expect(fixturePolicy({ lspGateExempt: "no toolchain" })).toBe(
			"Exempt from the clean gate.",
		);
		expect(fixturePolicy({ auxiliaryServerIds: ["opengrep"] })).toBe(
			"Auxiliary, not gated.",
		);
		expect(fixturePolicy({})).toBe("");
	});
});

describe("saveVerdictCells: the three columns a run owns", () => {
	const measured = (overrides = {}) =>
		saveVerdictCells({
			server: "cpp",
			save: "save",
			mode: "push-only",
			fixture: { lang: "cpp", lspGate: true },
			arms: { noSave: arm(3, 97), saveAlone: arm(0) },
			waitMs: 6000,
			src: "ci",
			...overrides,
		});

	it("writes the verdict value, the evidence command and the policy", () => {
		const cells = measured();
		expect(cells[SAVE_VERDICT_COLUMN]).toBe("no");
		expect(cells[SAVE_VERDICT_COLUMN]).not.toBe("unknown");
		expect(cells.verdict).toContain("3 findings at 97 ms");
		expect(cells.verdict).toContain("Gated.");
		expect(cells.evidence).toContain("node scripts/probe-save-verdict.mjs");
		expect(cells.evidence).toContain("src=ci");
	});

	it("keeps `unknown` out of a measured row entirely", () => {
		for (const arms of [
			{ noSave: arm(1) },
			{ noSave: arm(0), saveAlone: arm(1) },
			{ noSave: arm(0), saveAlone: arm(0), savedWrite: arm(1) },
			{ noSave: arm(0), saveAlone: arm(0) },
		]) {
			expect(
				SAVE_VERDICT_VALUES.has(measured({ arms })[SAVE_VERDICT_COLUMN]),
			).toBe(true);
			expect(measured({ arms })[SAVE_VERDICT_COLUMN]).not.toBe("unknown");
		}
	});

	it("states the arms in an inconclusive row", () => {
		const cells = measured({ arms: { noSave: arm(0), saveAlone: arm(0) } });
		expect(cells[SAVE_VERDICT_COLUMN]).toBe("inconclusive");
		expect(cells.verdict).toContain("no arm published");
	});
});

describe("refreshSaveVerdictTable: the merge guard (#390)", () => {
	it("rewrites measured rows and copies unreached ones verbatim", () => {
		const cells = saveVerdictCells({
			server: "cpp",
			save: "save",
			mode: "push-only",
			fixture: { lang: "cpp", lspGate: true },
			arms: { noSave: arm(3, 97), saveAlone: arm(0) },
			waitMs: 6000,
			src: "ci",
		});
		const { text, changed, measured, kept } = refreshSaveVerdictTable(DOC, [
			cells,
		]);
		expect(changed).toBe(true);
		expect(measured).toEqual(["cpp"]);
		// The cmake row this run could not reach keeps its evidence byte for byte.
		expect(kept).toContain("cmake");
		expect(text).toContain(
			"| cmake | `save` | unknown | Unverified: not measured. | none |",
		);
		expect(text).toContain("| cpp | `save` | no | Measured:");
		// A source-read row nobody measured is untouched, citation included.
		expect(text).toContain("golang/tools `02c9e4c`");
		// Everything outside the table survives.
		expect(text).toContain("## Next section\n\nUntouched prose.");
	});

	it("is a no-op for a run that measured nothing", () => {
		const { text, changed } = refreshSaveVerdictTable(DOC, []);
		expect(changed).toBe(false);
		expect(text).toBe(DOC);
	});

	it("does not append a server the table does not list, and names it", () => {
		// The population is the capability inventory's save-declaring servers, one
		// row per registry id. A launch VARIANT that declares `save` under an id the
		// inventory records as declaring none (typescript's TS7 variants) must not
		// add a row contradicting the inventory — it is reported instead.
		const cells = saveVerdictCells({
			server: "typescript",
			save: "save+text",
			mode: "push-only",
			fixture: { lang: "typescript7" },
			arms: { noSave: arm(1, 12) },
			waitMs: 6000,
			src: "ci",
		});
		const result = refreshSaveVerdictTable(DOC, [cells]);
		expect(result.notInTable).toEqual(["typescript"]);
		expect(result.measured).toEqual([]);
		expect(result.text).toBe(DOC);
	});

	it("refuses to rewrite anything when the doc has no save-verdict table", () => {
		const { text, changed, reason } = refreshSaveVerdictTable(
			"# nothing here",
			[
				{
					server: "cpp",
					[SAVE_VERDICT_COLUMN]: "no",
				},
			],
		);
		expect(changed).toBe(false);
		expect(text).toBe("# nothing here");
		expect(reason).toBe("save-verdict table not found in doc");
	});
});

describe("parseSaveVerdictRows / orderByNeed: a bounded run converges", () => {
	it("reads the three columns back", () => {
		expect(parseSaveVerdictRows(DOC)).toEqual([
			{ server: "cpp", save: "`save`", verdict: "unknown" },
			{ server: "cmake", save: "`save`", verdict: "unknown" },
			{ server: "gopls", save: "`save`", verdict: "no" },
		]);
	});

	it("orders unmeasured rows first so a short budget cannot starve them", () => {
		const fixtures = [
			{ lang: "cpp" },
			{ lang: "cmake" },
			{ lang: "gopls" },
			{ lang: "clojure" },
		];
		// `go` already has a measured verdict; `cpp`, `cmake` and `clojure` do not.
		expect(
			orderByNeed(fixtures, parseSaveVerdictRows(DOC), (fx) => fx.lang).map(
				(fx) => fx.lang,
			),
		).toEqual(["cpp", "cmake", "clojure", "gopls"]);
	});

	it("keeps fixture order among equals and admits the measured vocabulary", () => {
		const fixtures = [{ lang: "b" }, { lang: "a" }];
		expect(
			orderByNeed(fixtures, [], (fx) => fx.lang).map((fx) => fx.lang),
		).toEqual(["b", "a"]);
		expect(
			orderByNeed(
				fixtures,
				[{ server: "b", verdict: "cannot measure" }],
				(fx) => fx.lang,
			).map((fx) => fx.lang),
		).toEqual(["a", "b"]);
	});

	it("probes a row marked inconclusive again", () => {
		expect(
			orderByNeed(
				[{ lang: "cmake" }, { lang: "go" }],
				[
					{ server: "cmake", verdict: "inconclusive" },
					{ server: "go", verdict: "yes" },
				],
				(fx) => fx.lang,
			).map((fx) => fx.lang),
		).toEqual(["cmake", "go"]);
	});
});

describe("SAVE_VERDICT_MARKER", () => {
	it("is the table header the doc carries", () => {
		expect(SAVE_VERDICT_MARKER).toBe("| server | save as declared |");
		expect(DOC).toContain(SAVE_VERDICT_MARKER);
	});
});
