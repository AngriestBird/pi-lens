import { describe, expect, it } from "vitest";
import {
	detectIndentation,
	hasDetectableIndentation,
} from "../../../clients/dispatch/indent-detect.js";

const T = "\t";

/**
 * The #3039 state-space table, one row per input shape the detector can see.
 * Each row is measured through the real `detectIndentation`; the PR body holds
 * the same table with the master / pre-fix / candidate columns.
 */
const ROWS: Array<{
	id: string;
	content: string;
	expected: { style: string; width: number } | undefined;
}> = [
	{
		id: "R1 2-space file, no comments",
		content:
			"function a() {\n  const x = 1;\n  if (x) {\n    return x;\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R2 4-space file, no comments",
		content:
			"function a() {\n    const x = 1;\n    if (x) {\n        return x;\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039 F1): a top-level JSDoc contributes a run of
		// 1-space ` * ` lines anchored by `/**` at column 0, which certified width
		// 1 on every doc-commented 2- or 4-space file and rewrote it on pass 1.
		id: "R3 2-space file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n */\nfunction add(a, b) {\n  const sum = a + b;\n  if (sum) {\n    return sum;\n  }\n  return 0;\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Same recurrence as R3, 4-space arm (#3039 F1).
		id: "R4 4-space file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n */\nfunction add(a, b) {\n    const sum = a + b;\n    if (sum) {\n        return sum;\n    }\n    return 0;\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// #3039 F1 with a `/*` banner rather than a `/**` doc block: the closing
		// ` */` line is a 1-space line too.
		id: "R5 2-space file with a banner block comment",
		content:
			"/*\n * Copyright 2026 Example.\n * SPDX-License-Identifier: MIT\n */\nexport function main() {\n  run();\n  if (ok) {\n    done();\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R6 tab file, no comments",
		content: `function a() {\n${T}const x = 1;\n${T}if (x) {\n${T}${T}return x;\n${T}}\n}\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		// Recurrence this pins (#3039 F2): a top-level JSDoc has more 1-space
		// continuation lines than the file has tab-indented lines, so the
		// space-majority branch won and a tab file was pinned to spaces.
		id: "R7 tab file with a JSDoc",
		content:
			"/**\n * Adds two numbers.\n * @param a first\n * @param b second\n * @returns the sum\n */\n" +
			`function add(a, b) {\n${T}const sum = a + b;\n${T}if (sum) {\n${T}${T}return sum;\n${T}}\n${T}return 0;\n}\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		// Recurrence this pins (#3038): the shallowest run is continuation
		// alignment, not the formatter's unit, so each format multiplied it.
		id: "R8 aligned continuation run",
		content: "const value = call(\n      first,\n      second,\n    );\n",
		expected: { style: "space", width: 2 },
	},
	{
		// #3038, continuation nested inside a 2-space body.
		id: "R8b aligned continuation inside a 2-space body",
		content:
			"function values() {\n  return [\n      1,\n      2,\n      3,\n  ];\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Recurrence this pins (#3038): a nested-only file cannot distinguish its
		// first run from one indentation unit, so style pinning is declined.
		id: "R9 nested-only ambiguity",
		content: "      nested\n            deeper\n",
		expected: undefined,
	},
	{
		id: "R9b nested-only siblings",
		content: "      nested\n      sibling\n",
		expected: undefined,
	},
	{
		id: "R10 mixed tabs and spaces, space majority",
		content: `top\n  one\n    two\n${T}three\n`,
		expected: { style: "space", width: 2 },
	},
	{
		id: "R10b mixed tabs and spaces, tab majority",
		content: `top\n${T}one\n${T}${T}two\n${T}three\n  four\n`,
		expected: { style: "tab", width: 1 },
	},
	{
		id: "R11 minimum above the plausible-unit cap, nested-only",
		content: "top\n          ten\n                    twenty\n",
		expected: undefined,
	},
	{
		// Recurrence this pins (#3039 F3): without the `minimum <= 8` cap this
		// shape certifies width 10 — a structurally supported but implausible
		// unit — and the formatter re-indents the file ten spaces per level.
		id: "R11b minimum above the cap with a structural boundary",
		content: "function f() {\n          deep();\n}\n",
		expected: undefined,
	},
	{
		// Recurrence this pins (#3039 F3): the `gcd <= 8` arm of the same cap.
		// 20/30 spaces have gcd 10, below the minimum but not a plausible unit.
		id: "R11c gcd above the cap",
		content: `x\n${" ".repeat(20)}a\n${" ".repeat(30)}b\n`,
		expected: undefined,
	},
	{
		id: "R12 single indent level",
		content: "function a() {\n    const x = 1;\n    return x;\n}\n",
		expected: { style: "space", width: 4 },
	},
	{ id: "R13 empty", content: "", expected: { style: "space", width: 2 } },
	{
		id: "R14 whitespace-only",
		content: `\n   \n${T}\n\n`,
		expected: { style: "space", width: 2 },
	},
	{
		// #3039 F1: with the block comment removed from the evidence this file
		// has no indented line at all, so it falls to the safe default instead of
		// certifying width 1 from its ` * ` lines.
		id: "R15 block-comment continuations are the only indented lines",
		content:
			"/**\n * A module with no indented code.\n */\nexport const x = 1;\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R16 2-space file with a nested JSDoc",
		content:
			"class A {\n  /**\n   * Does a thing.\n   */\n  run() {\n    go();\n  }\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		// Recurrence this pins (#3039, rejected candidate A): filtering every
		// line matching /^\s*\*/ out of the evidence also eats generator methods
		// and C pointer declarations, which are structural code.
		id: "R17 generator method whose line starts with *",
		content: "class A {\n    *items() {\n        yield 1;\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Same rejected candidate A: prettier formats Markdown, whose bullet
		// markers are structural indentation.
		id: "R18 Markdown bullet list, 2-space nesting",
		content: "# Title\n\n* one\n  * nested\n* two\n  * nested two\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R18b Markdown bullet list, 4-space nesting",
		content: "# Title\n\n* one\n    * nested\n* two\n    * nested two\n",
		expected: { style: "space", width: 4 },
	},
	{
		id: "R19 CSS with a block comment",
		content: "/* palette */\n.a {\n  color: red;\n}\n.b {\n  color: blue;\n}\n",
		expected: { style: "space", width: 2 },
	},
	{
		id: "R20 Python with indented # comments",
		content:
			"def f():\n    # explain\n    x = 1\n    if x:\n        # nested note\n        return x\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a `/*` inside a string literal must not
		// open a comment region that swallows the rest of the file's evidence.
		// The opener never closes, so its lines stay structural.
		id: "R21 unterminated /* inside a string literal",
		content:
			'const open = "/*";\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n',
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a `/*` that follows `//` on the same line
		// is inside a line comment, not an opener. A later block comment closes,
		// so a false region opened here swallows the file's whole 4-space body
		// instead of being restored as an unterminated opener (R21's path).
		id: "R21b /* inside a line comment, with a later block comment",
		content:
			"// matches /* here\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n/**\n * trailing doc\n */\nexport const x = 1;\n",
		expected: { style: "space", width: 4 },
	},
	{
		// Recurrence this pins (#3039): a block comment that opens and closes on
		// one line opens no region. The later block comment supplies the `*/`
		// that a false region would close on.
		id: "R21c one-line block comment, with a later block comment",
		content:
			"/* banner */\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n/**\n * trailing doc\n */\nexport const x = 1;\n",
		expected: { style: "space", width: 4 },
	},
	{
		// The converse of R21b: a `//` that follows the `/*` on the same line is
		// a URL inside the banner, not a line comment, so the banner still opens
		// its region and its ` * ` lines stay out of the evidence.
		id: "R21d multi-line banner whose opener carries a URL",
		content:
			"/* see https://example.com/spec\n * details\n */\nfunction f() {\n    go();\n    if (a) {\n        b();\n    }\n}\n",
		expected: { style: "space", width: 4 },
	},
	{
		id: "R22 shell tabs with # comments",
		content: `#!/bin/sh\n# a script\nf() {\n${T}echo hi\n${T}if true; then\n${T}${T}echo deep\n${T}fi\n}\n`,
		expected: { style: "tab", width: 1 },
	},
];

describe("indentation detection state space (#3038, #3039)", () => {
	it.each(ROWS.map((row) => [row.id, row] as const))("%s", (_id, row) => {
		expect(detectIndentation(row.content)).toEqual(row.expected);
	});

	it.each([
		["      nested\n", true],
		[`${T}one\n`, true],
		["/**\n * doc\n */\nconst x = 1;\n", true],
		["", false],
		["const x = 1;\n", false],
	] as const)(
		"hasDetectableIndentation reports leading whitespace for %j",
		(content, expected) => {
			expect(hasDetectableIndentation(content)).toBe(expected);
		},
	);
});
