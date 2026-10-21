import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintFoldCheck,
	lintLocalPrBody,
	lintPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4711: AGENTS.md requires a `## Fold check` section in every PR body, and
// `scripts/check-pr-body.mjs` never read it. A PR opened with `gh pr create`
// therefore skipped the rule while the maintainer's local script
// (`pr-create.sh`'s `fold_gate`) refused the body: two fixer-written bodies on
// 2026-10-21 were refused by the local gate and would have passed CI.
//
// The lint owns the FORM, because it cannot read the issue tracker: a decision
// line names its candidate (`#N`), one of the three decisions, and a reason
// after the decision word; or the section says `none: <reason>`. The local
// script owns the candidate list. Both read the same three facts in the same
// order, so one body satisfies both gates.
const body = (fold: string) =>
	[
		"## Why",
		"The body gate records the fold decision.",
		"",
		"## Notes for the reviewer",
		"None.",
		"",
		"## Change outline",
		"- scripts/check-pr-body.mjs",
		"",
		"## Summary",
		"The lint reads the fold check section.",
		"",
		"## Tests",
		"Targeted tests pass.",
		"",
		"## Blast radius",
		"No runtime module touched.",
		"",
		"## Class sweep",
		'Defect shape: a documented rule with no gate. Search: `rg -n "fold check" scripts`. Verdict: folded onto the body lint.',
		"",
		"## Observability",
		"No new failure path; no record added.",
		"",
		"## Fold check",
		fold,
	].join("\n");
const withoutFold = (text: string) =>
	text.slice(0, text.indexOf("\n\n## Fold check"));
const folded = [
	"#4606 not folded: a different file and a separate rule.",
	"#4602 folded: the same body-lint seam, so its rule lands here.",
	"#3260 sequenced: after this form lands and its tests run.",
].join("\n");

describe("Fold check form (#4711)", () => {
	it.each([
		["folded", "#4602 folded: the same body-lint seam."],
		["not folded", "#4606 not folded: a different rule and file."],
		["sequenced", "#3260 sequenced: after this form lands."],
	])("accepts a %s decision with its reason", (_name, line) => {
		expect(lintFoldCheck(body(line))).toEqual([]);
	});

	it("accepts a decision table row", () => {
		const table = [
			"| candidate | decision | reason |",
			"| --- | --- | --- |",
			"| #4606 | not folded | a different file and rule |",
		].join("\n");
		expect(lintFoldCheck(body(table))).toEqual([]);
	});

	it("accepts none: with a reason of at least three words", () => {
		expect(lintFoldCheck(body("none: the search listed no candidate"))).toEqual(
			[],
		);
	});

	// Acceptance item 2: a decision word with no reason is not a decision. The
	// local gate refuses it too (`fold_gate` needs two words after the word).
	it("refuses a decision word with no reason", () => {
		const errors = lintFoldCheck(body("#4606 not folded"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"## Fold check"');
		expect(errors[0]).toContain(".github/PULL_REQUEST_TEMPLATE.md");
	});

	it("refuses a decision line that names no candidate", () => {
		expect(
			lintFoldCheck(body("not folded: a different file and rule")),
		).toEqual([expect.stringContaining('"## Fold check"')]);
	});

	// Fail closed (engineering principles §1): the admitted forms are the
	// decision line and `none:`; an unrecognised line does not satisfy either.
	it("refuses a section holding neither form", () => {
		expect(lintFoldCheck(body("TODO: decide after the round."))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	it("refuses none: with a reason of fewer than three words", () => {
		expect(lintFoldCheck(body("none: nothing found"))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	// A quoted example is not a decision. The class sweep accepts a search
	// command inside a fence, but a verdict is prose the author wrote.
	it.each([
		[
			"a fenced example",
			["```text", "#4606 not folded: a different file", "```"],
		],
		["an HTML comment", ["<!-- #4606 not folded: a different file -->"]],
	])("does not read a decision out of %s", (_name, lines) => {
		expect(lintFoldCheck(body(lines.join("\n")))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	// The first section is the record, as for `## Observability` and for the
	// local gate's awk reader; a later section cannot rescue an empty one.
	it("reads only the first section", () => {
		const twice = `${body("TODO: decide later.")}\n\n## Fold check\n${folded}`;
		expect(lintFoldCheck(twice)).toHaveLength(1);
	});

	// The section ends at the next heading of the same or a higher level: a
	// decision written under a later section is not this section's verdict.
	it("does not read a decision from the next section", () => {
		const leak = [
			"## Fold check",
			"Decide after the round.",
			"",
			"## Tests",
			"#4606 not folded: a different file and rule.",
		].join("\n");
		expect(lintFoldCheck(leak)).toHaveLength(1);
	});

	// Acceptance item 4: one parser for both sections' verdict forms, so one
	// body satisfies the repository lint and the local script's class gate.
	it("lets one body satisfy the fold check and the class sweep", () => {
		const text = body(folded);
		expect(lintFoldCheck(text)).toEqual([]);
		expect(lintClassSweep(text)).toEqual([]);
	});
});

describe("Fold check section requirement (#4711)", () => {
	it("refuses a body with no section", () => {
		const result = lintPrBody(withoutFold(body("none: no candidate listed")), {
			workingTree: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.stringContaining('missing "## Fold check"'),
		]);
	});

	// Acceptance item 3: the lint has no docs-only exemption for body sections,
	// so a docs diff carries the section like any other and answers it `none:`.
	it("requires the section for a docs-only diff", () => {
		const diff = [
			"diff --git a/docs/pi-lens-fixer.md b/docs/pi-lens-fixer.md",
			"@@ -1,0 +1,1 @@",
			"+A doc line.",
		].join("\n");
		const missing = lintPrBody(withoutFold(body("none: no candidate listed")), {
			workingTree: true,
			diff,
		});
		expect(missing.errors).toContainEqual(
			expect.stringContaining('missing "## Fold check"'),
		);
		expect(lintFoldCheck(body("none: docs only, no runtime code."))).toEqual(
			[],
		);
	});

	it("refuses a section with no content before the next heading", () => {
		const result = lintPrBody(body(""), { workingTree: true });
		expect(result.errors).toContainEqual(
			expect.stringContaining(
				'no content before the next heading "## Fold check"',
			),
		);
	});

	it("reaches the local preflight composition", () => {
		const stub = (): string => "";
		const missing = lintLocalPrBody(
			withoutFold(body("none: no candidate listed")),
			process.cwd(),
			stub as never,
		);
		expect(missing.errors.join(" ")).toContain('missing "## Fold check"');
		expect(
			lintLocalPrBody(body(folded), process.cwd(), stub as never).errors.join(
				" ",
			),
		).not.toContain('"## Fold check"');
	});
});
