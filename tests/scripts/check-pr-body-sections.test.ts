import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintFoldCheck,
	lintLocalPrBody,
	lintPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4717: a required section exists only where the reader sees one. Each round
// of #4717 found a body whose section list the hand-written comment and
// code-span scanner read differently from GitHub, in both directions: a
// hidden section counted (V4: a backtick pair across a blank line shielded a
// block comment) and a visible one went missing (V5: a heading inside an
// unclosed inline comment). The lexer seam (`scripts/lib/markdown-lexer.mjs`)
// reads the body now. Every row below is a body class from the round-4 state
// table; its expected section list is GitHub's own gfm render of that body
// (`POST /markdown`, recorded 2026-10-21), an oracle independent of the code,
// except where a row says the lint departs from it by decision.

const SECTIONS = [
	"Summary",
	"Tests",
	"Blast radius",
	"Class sweep",
	"Observability",
	"Fold check",
];
const HEAD = [
	"## Why",
	"The body gate reads the sections a reader sees.",
	"",
	"## Notes for the reviewer",
	"None.",
	"",
	"## Change outline",
	"- scripts/check-pr-body.mjs",
	"",
	"## Summary",
].join("\n");
const TAIL = [
	"## Blast radius",
	"No runtime module touched.",
	"",
	"## Class sweep",
	'Defect shape: x. Search: `rg -n "x" scripts`. Verdict: folded onto the lexer.',
	"",
	"## Observability",
	"No new failure path; no record added.",
	"",
	"## Fold check",
	"#4606 not folded: a different file and a separate rule.",
].join("\n");
const body = (middle: string) => `${HEAD}\n${middle}\n\n${TAIL}`;
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const TESTS = "## Tests\nTargeted tests pass.";
const AFTER_SUMMARY = [
	"Blast radius",
	"Class sweep",
	"Observability",
	"Fold check",
];
const stub = (): string => "";

const missing = (errors: string[]) =>
	SECTIONS.filter((name) =>
		errors.some((error) => error.includes(`missing "## ${name}"`)),
	);

// [case, body, sections GitHub does not render]
const cases: Array<[string, string, string[]]> = [
	[
		"B1 a closed block comment hides ## Tests (F1)",
		body("Text.\n\n<!--\n## Tests\nhidden\n-->"),
		["Tests"],
	],
	[
		"B2 an unclosed block opener hides the rest",
		body("Text.\n\n<!--\n## Tests\nhidden"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B3 a 3-space block opener hides the rest",
		body("Text.\n\n   <!--\n## Tests\nhidden"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B4 a 4-space opener after a blank line is code",
		body(`Text.\n\n    <!--\n## Tests\nx\n-->\n\n${TESTS}`),
		[],
	],
	[
		"B5 a 4-space opener continuing a paragraph is text",
		body("Text.\n    <!--\n## Tests\nx\n-->"),
		[],
	],
	[
		"B6 a block comment only --!> ends hides the rest",
		body("Text.\n\n<!--\n## Tests\nhidden\n--!>"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B7 an abrupt <!--> at a line start hides nothing after it",
		body(`Text.\n\n<!-->\n${TESTS}`),
		[],
	],
	[
		"B8 a block comment spans blank lines",
		body("Text.\n\n<!--\npara\n\n## Tests\n\npara\n-->"),
		["Tests"],
	],
	[
		"I1 an inline comment closed on its line",
		body(`Text <!-- note --> more.\n\n${TESTS}`),
		[],
	],
	[
		"I2 an inline opener with no end (V1)",
		body(`The scan reads <!-- as an opener.\n\n${TESTS}`),
		[],
	],
	[
		"I3 an inline opener closed past a blank line (V1)",
		body(`Reads <!-- as an opener.\n\n--> closes it.\n\n${TESTS}`),
		[],
	],
	[
		"I4 an opener in a code span (V1, Greptile P1)",
		body(`The scan reads \`<!--\` as an opener.\n\n${TESTS}`),
		[],
	],
	[
		"I5 a code-span opener closed in a later fence (V1)",
		body(`Reads \`<!--\`.\n\n\`\`\`text\n<!-- c -->\n\`\`\`\n\n${TESTS}`),
		[],
	],
	[
		"I6 an inline comment over two lines",
		body(`Text <!-- spans\ntwo lines --> end.\n\n${TESTS}`),
		[],
	],
	[
		"V5 a heading ends an unclosed inline comment (Greptile P1)",
		body(
			"The scan reads <!-- as an opener.\n## Tests\nTargeted tests pass. -->",
		),
		[],
	],
	[
		"V5 the same with blank lines",
		body(
			"The scan reads <!-- as an opener.\n\n## Tests\nTargeted tests pass. -->",
		),
		[],
	],
	[
		"V5 the same in CRLF",
		crlf(
			body(
				"The scan reads <!-- as an opener.\n## Tests\nTargeted tests pass. -->",
			),
		),
		[],
	],
	[
		"V4 a stray backtick pair straddles a block comment (Greptile P1)",
		body(
			"One stray ` backtick.\n\n<!--\n## Tests\nhidden\n-->\n\nAnother stray ` backtick.",
		),
		["Tests"],
	],
	[
		"V4 the same in CRLF (CodeRabbit)",
		crlf(
			body(
				"One stray ` backtick.\n\n<!--\n## Tests\nhidden\n-->\n\nAnother stray ` backtick.",
			),
		),
		["Tests"],
	],
	[
		"V4 a backtick in one comment pairs with one in the next",
		body("<!-- one ` tick -->\n\n<!-- two ` tick\n## Tests\nhidden\n-->"),
		["Tests"],
	],
	[
		"V4 a stray backtick before a block comment and a fence after",
		body("A stray ` here.\n\n<!--\n## Tests\nhidden\n-->\n\n```\nx\n```"),
		["Tests"],
	],
	[
		"G1 a fence holding <!--",
		body(`Text.\n\n\`\`\`\n<!--\n\`\`\`\n\n${TESTS}`),
		[],
	],
	[
		"H1 a heading inside a comment beside the real one",
		body(`Text.\n\n${TESTS}\n\n<!--\n## Blast radius\n-->`),
		[],
	],
	[
		"S1 a setext heading",
		body("Text.\n\nTests\n-----\nTargeted tests pass."),
		[],
	],
	[
		"S4 an ATX heading indented three spaces",
		body("Text.\n\n   ## Tests\nTargeted tests pass."),
		[],
	],
	[
		"S5 an ATX heading with closing hashes",
		body("Text.\n\n## Tests ##\nTargeted tests pass."),
		[],
	],
	[
		"S6 a heading in indented code",
		body("Text.\n\n    ## Tests\n    x"),
		["Tests"],
	],
	["S7 an escaped heading", body("Text.\n\n\\## Tests\nx"), ["Tests"]],
	[
		"T6 a <details> block with no blank line swallows ## Tests",
		body("Text.\n\n<details>\n## Tests\nx\n</details>"),
		["Tests"],
	],
	[
		"T6 a <details> block with blank lines keeps ## Tests",
		body(
			"Text.\n\n<details>\n<summary>s</summary>\n\n## Tests\nx\n\n</details>",
		),
		[],
	],
	[
		"T7 a bare <span> line opens an HTML block that swallows ## Tests",
		body("Text.\n\n<span>\n## Tests\nx"),
		["Tests"],
	],
	// By decision, not the render: GitHub renders an <h2> nested in a list
	// item or a block quote, but a nested heading is no section of the
	// document, so the lint refuses it (fail closed, live population 0).
	[
		"S2 a heading in a list item is refused by decision",
		body("Text.\n\n- ## Tests\n  Targeted tests pass."),
		["Tests"],
	],
	[
		"S3 a heading in a block quote is refused by decision",
		body("Text.\n\n> ## Tests\n> Targeted tests pass."),
		["Tests"],
	],
	// By decision too: #1844 accepts H3 and H4 section headings, so `#### Tests`
	// is the Tests section although GitHub renders no <h2>.
	[
		"S8 an H4 heading is the section (#1844)",
		body("Text.\n\n#### Tests\nx"),
		[],
	],
];

describe("PR body sections as the reader sees them (#4717)", () => {
	it.each(cases)("%s (CI entry)", (_name, text, hidden) => {
		const errors = lintPrBody(text, { workingTree: true }).errors;
		expect(missing(errors)).toEqual(hidden);
		if (hidden.length === 0) expect(errors).toEqual([]);
	});

	it.each(cases)("%s (local entry)", (_name, text, hidden) => {
		const errors = lintLocalPrBody(text, process.cwd(), stub as never).errors;
		expect(missing(errors)).toEqual(hidden);
		if (hidden.length === 0) expect(errors).toEqual([]);
	});

	it("starts a setext section after its underline", () => {
		// Recurrence it prevents: the underline is part of the heading, so a
		// section holding only its own `-----` would count as written.
		const text = body("Text.\n\nTests\n-----\n");
		expect(lintPrBody(text, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('"## Tests"'),
		);
	});
});

describe("section text drops every raw-HTML block (#4717)", () => {
	const fold = (section: string) =>
		body(TESTS).replace(
			"#4606 not folded: a different file and a separate rule.",
			section,
		);

	it("refuses a fold decision written only inside a <details> block", () => {
		// GitHub shows a raw-HTML block's text, collapsed; it is not a decision
		// the lint reads (fail closed, by decision).
		expect(
			lintFoldCheck(
				fold(
					"<details>\n#4606 not folded: a different file and rule.\n</details>",
				),
			),
		).toEqual([expect.stringContaining('"## Fold check"')]);
	});

	it("reads a fold decision after a raw-HTML block", () => {
		expect(
			lintFoldCheck(
				fold(
					"<details>\nnote\n</details>\n\n#4606 not folded: a different file and rule.",
				),
			),
		).toEqual([]);
	});

	it("refuses a class-sweep verdict written only inside a raw-HTML block", () => {
		const sweep = [
			"## Class sweep",
			'Defect shape: x. Search: `rg -n "x" scripts`.',
			"<div>",
			"Verdict: folded onto the lexer.",
			"</div>",
		].join("\n");
		expect(lintClassSweep(sweep)).toHaveLength(1);
		expect(
			lintClassSweep(sweep.replace("<div>\n", "\n").replace("\n</div>", "")),
		).toEqual([]);
	});
});
