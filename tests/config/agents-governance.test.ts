import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	blankMarkdown,
	parseDefectShapes,
} from "../../scripts/lib/defect-shapes.mjs";
import { stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function agentsText(): string {
	return fs.readFileSync(
		process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
		"utf8",
	);
}

/** The numbered catalog (#4361): AGENTS.md keeps only the trigger-grouped index. */
function catalogText(): string {
	return fs.readFileSync(path.join(REPO_ROOT, "docs/defect-shapes.md"), "utf8");
}

function shapeNumbers(text: string): number[] {
	const source = stripSource(blankMarkdown(text), { strings: "blank" });
	return [...source.matchAll(/^(\d+)\. \*\*/gm)].map((match) =>
		Number(match[1]),
	);
}

describe("AGENTS.md trigger-block governance (#3259)", () => {
	// The trigger wrappers are the loaded file's, so these two cases read
	// AGENTS.md even though docs/defect-shapes.md keeps the same wrappers around
	// the entries it owns.
	it("keeps every trigger marker standalone and paired (#3265)", () => {
		const text = agentsText();
		const literalOpenings = [...text.matchAll(/<important if=/g)].length;
		const anchoredOpenings = [...text.matchAll(/^<important if="[^"]*">$/gm)]
			.length;
		const anchoredClosings = [...text.matchAll(/^<\/important>$/gm)].length;
		expect(literalOpenings).toBe(anchoredOpenings);
		expect(anchoredOpenings).toBe(anchoredClosings);
	});

	it("gives every important block one unique non-empty trigger", () => {
		const triggers = [
			...agentsText().matchAll(/^<important if="([^"]*)">$/gm),
		].map((match) => match[1].trim());
		expect(triggers.length).toBeGreaterThan(0);
		expect(triggers.every(Boolean)).toBe(true);
		expect(new Set(triggers).size).toBe(triggers.length);
	});

	it("keeps every numbered defect shape exactly once", () => {
		const numbers = shapeNumbers(catalogText());
		expect(numbers).toHaveLength(86);
		expect(new Set(numbers).size).toBe(86);
		expect(numbers.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 86 }, (_, index) => index + 1),
		);
	});

	it("does not count a counterfeit shape hidden in an HTML comment (#3265)", () => {
		// Prevents a comment counterfeit from replacing a real catalog member.
		const counterfeit = catalogText()
			.replace(/^1\. \*\*.*$/m, "")
			.concat("\n<!--\n1. **Counterfeit shape:** hidden comment\n-->\n");
		expect(shapeNumbers(counterfeit)).toHaveLength(85);
		expect(shapeNumbers(counterfeit)).not.toContain(1);
	});

	// #4361: AGENTS.md's index is a hand-kept mirror of the catalog, so an entry
	// added, renumbered or dropped on one side alone makes the loaded file and
	// the entry disagree (shape 12, a mirror refreshed outside its guard). Each
	// index line carries its entry's number and name, and the two populations
	// must match: same numbers, same names.
	it("keeps the AGENTS.md index in step with the catalog", () => {
		const catalog = [...parseDefectShapes(catalogText())];
		const index = [...parseDefectShapes(agentsText())];
		const names = (entries: [number, string][]) =>
			entries
				.map(([number, entry]) => [
					number,
					/^\d+\. \*\*(.+?):\*\*/.exec(entry.replace(/\s+/g, " "))?.[1],
				])
				.sort((a, b) => Number(a[0]) - Number(b[0]));
		expect(index.length).toBe(catalog.length);
		expect(names(index)).toEqual(names(catalog));
	});

	it("keeps issue and PR references in AGENTS.md from growing", () => {
		// Recurrence: PR #4270's first draft put three incident numbers into an
		// AGENTS.md rule. Maintainer, 2026-10-10: AGENTS.md stays lean and
		// HISTORY.md carries issues, PRs and examples. Lower the baseline when a
		// reference moves to HISTORY.md. The one raise (113 -> 119) is the two
		// catalog shapes the maintainer approved on 2026-10-17 (#4565); each
		// instance number is what makes a shape recognisable. The 2026-10-20
		// shapes 76-78 cite no instance number: each entry names its guard's
		// test path, and each instance date lives in `HISTORY.md` under a
		// heading naming the shape, so this pin does not move. Shape 78's guard
		// shipped (#4679), so its entry names the running path instead of a
		// branch, which adds no reference either. Shape 79 (approved by the
		// maintainer on 2026-10-20) is the second raise, 119 -> 120: its guard is
		// unbuilt, so the entry names the tracker (#4687) instead of a path, and
		// the instances stay in `HISTORY.md`. The 2026-10-21 retro adds the third
		// raise, 120 -> 121: shape 66 names the issue that drives its
		// `in-process-mock` census down (#4709), because a census without its
		// tracker names nothing a reader can act on.
		// The 2026-10-24 maintainer decision on #4682 adds the fourth raise, 121 ->
		// 124: shape 84 names its three instance issues (#4293, #4294, #4682), the
		// wording the maintainer set for the lazy axis.
		// The 2026-10-25 maintainer decision adds the fifth raise, 124 -> 125:
		// shape 86 names its unbuilt detector's tracker (#4865), as shape 79 did.
		// #4361 moves it 125 -> 55: the numbered entries, with their instance
		// numbers, now live in `docs/defect-shapes.md`, and AGENTS.md keeps an
		// index of screen sentences. The guard still ratchets what a rule line
		// adds to the loaded file.
		expect(issueRefs(agentsText())).toBeLessThanOrEqual(55);
	});

	it("counts a reference and not a heading anchor", () => {
		// Recurrence: the #4565 digest links heading anchors such as
		// `docs/engineering-principles.md#1-building`, which `#\d+\b` read as
		// twelve issue references and inflated the ratchet above its pin.
		expect(issueRefs("fixed in #4554 and #4563.")).toBe(2);
		expect(issueRefs("([§1](docs/engineering-principles.md#1-building))")).toBe(
			0,
		);
		expect(issueRefs("https://github.com/o/r/pull/4565")).toBe(1);
	});
});

function issueRefs(text: string): number {
	// `#N` of any length, and issue/PR URLs, which carry no `#` (review F-4272-1).
	// A markdown heading anchor (`#1-building`) is a fragment, not a reference.
	return [
		...blankMarkdown(text).matchAll(
			/#\d+\b(?!-[A-Za-z_])|\/(?:issues|pull)\/\d+\b/g,
		),
	].length;
}
