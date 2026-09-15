import { describe, expect, it } from "vitest";
import { retargetReplacementIndentation } from "../../clients/indent-retarget.js";

describe("retargetReplacementIndentation", () => {
	// ── basic remapping ────────────────────────────────────────────────────────

	it("remaps spaces to tabs when oldText and newText share the same nesting depth", () => {
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n    return 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\treturn 2;\n}",
		);
	});

	it("remaps tabs to spaces", () => {
		const oldText = "function foo() {\n\treturn 1;\n}";
		const corrected = "function foo() {\n    return 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n    return 2;\n}",
		);
	});

	// ── deeper nesting not present in oldText ──────────────────────────────────

	it("remaps deeper nesting in newText using n × baseUnit extension", () => {
		// oldText only has 1 level (4 spaces); newText adds a nested block (8 spaces).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText =
			"function foo() {\n    if (x > 0) {\n        return x;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n}",
		);
	});

	it("remaps three nesting levels when only one was in oldText", () => {
		const oldText = "class A {\n    method() {}\n}";
		const corrected = "class A {\n\tmethod() {}\n}";
		// newText has 3 levels — none deeper than 1 appeared in oldText
		const newText =
			"class A {\n    method() {\n        if (x) {\n            return 1;\n        }\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"class A {\n\tmethod() {\n\t\tif (x) {\n\t\t\treturn 1;\n\t\t}\n\t}\n}",
		);
	});

	it("handles all levels already present in oldText via direct map", () => {
		// Both "    " and "        " appear in oldText → direct map hits for both.
		const oldText =
			"function foo() {\n    if (cond) {\n        return 1;\n    }\n}";
		const corrected = "function foo() {\n\tif (cond) {\n\t\treturn 1;\n\t}\n}";
		const newText =
			"function foo() {\n    if (cond) {\n        return 2;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (cond) {\n\t\treturn 2;\n\t}\n}",
		);
	});

	// ── abort on unresolvable indentation ─────────────────────────────────────

	it("returns undefined when a newText line has indentation that is not a multiple of the base unit", () => {
		// baseFrom = "    " (4 spaces); newText has a 3-space indent — not a multiple.
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n   if (x) {\n    const x = 2;\n   }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	it("returns undefined and does not partially remap when deeper lines use a different indent style", () => {
		// newText mixes 4-space (remappable) and tab (not in map and not a multiple of 4-space).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    if (x) {\n\t\treturn x;\n    }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	// ── edge cases ─────────────────────────────────────────────────────────────

	it("returns undefined when oldText and correctedOldText have different line counts", () => {
		expect(
			retargetReplacementIndentation("foo\nbar", "foo", "  foo"),
		).toBeUndefined();
	});

	it("returns undefined when there are no indentation differences between oldText and correctedOldText", () => {
		expect(
			retargetReplacementIndentation(
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
			),
		).toBeUndefined();
	});

	it("preserves blank and whitespace-only lines", () => {
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    const x = 1;\n\n    return x;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tconst x = 1;\n\n\treturn x;\n}",
		);
	});

	it("preserves CRLF line endings in the output", () => {
		const oldText = "function foo() {\r\n    return 1;\r\n}";
		const corrected = "function foo() {\r\n\treturn 1;\r\n}";
		const newText = "function foo() {\r\n    return 2;\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\r\n\treturn 2;\r\n}",
		);
	});

	it("returns undefined when no line in newText actually needs changing", () => {
		// newText already uses the corrected indentation — no change should be applied.
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}"; // already tabs
		// resolveIndent("\t"): not in map, not a multiple of "    " → abort → undefined
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});
});

// ── #3052: a block-comment continuation's alignment must not become the ────
// base nesting unit (AGENTS.md defect 49, third member — a shallowest leading
// run can be alignment, not one nesting unit). Each row's oldText/corrected
// pair gives the comment continuation and the code line DIFFERENT correction
// ratios so a base-unit mix-up produces a visibly wrong (not coincidentally
// right) deeper-nesting value.
describe("retargetReplacementIndentation — block-comment interior excluded from the base unit (#3052)", () => {
	it("bases a 4-space file's deeper nesting on the code line, not the JSDoc's 1-space alignment", () => {
		const oldText = "/**\n * doc\n */\nfunction f() {\n    go();\n}";
		// Comment ratio 1->2; code ratio 4->3 (deliberately different so a
		// comment-derived base would silently mis-scale, not coincide).
		const corrected = "/**\n  * doc\n  */\nfunction f() {\n   go();\n}";
		// "b();" nests one level deeper than anything in oldText — its indent
		// must extend from the code's own 4-space unit (4->3), not the
		// comment's 1-space one (1->2).
		const newText = "function g() {\n    a();\n        b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n   a();\n      b();\n}",
		);
	});

	it("bases a 2-space file's deeper nesting on the code line, not the JSDoc's 1-space alignment", () => {
		const oldText = "/**\n * doc\n */\nfunction f() {\n  go();\n}";
		// Comment ratio 1->3; code ratio 2->4.
		const corrected = "/**\n   * doc\n   */\nfunction f() {\n    go();\n}";
		const newText = "function g() {\n  a();\n      b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n    a();\n            b();\n}",
		);
	});

	it("keeps a tab file's deeper nesting in tabs instead of mixing in the comment's space alignment", () => {
		// The model guessed 2-space alignment for the comment continuation and
		// 4-space indentation for the code; the real file uses 1-space comment
		// alignment (typical even in tab files) and tabs for code.
		const oldText = "/**\n  * doc\n  */\nfunction f() {\n    go();\n}";
		const corrected = "/**\n * doc\n */\nfunction f() {\n\tgo();\n}";
		const newText = "function g() {\n    a();\n        b();\n}";
		// Bug shape: baseFrom picked from the comment ("  " -> " ") would put
		// literal SPACES into a tab file. Fixed: baseFrom is the code's own
		// "    " -> "\t" unit, so the deeper line doubles in tabs.
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("does not treat a generator method's leading `*` as a comment opener", () => {
		// Guards against an over-broad exclusion (any line starting with `*`,
		// or containing one at all) swallowing ordinary code — `*items()` has
		// no `/*` anywhere in it. The single-line body is deliberate: with no
		// sibling line at the same depth, excluding `*items()` would empty the
		// map entirely (abort to undefined) instead of merely picking a
		// different base — the sharpest observable signal for this guard.
		const oldText = "class C {\n  *items() { yield 1; }\n}";
		const corrected = "class C {\n\t*items() { yield 1; }\n}";
		const newText = "class D {\n  *values() {\n    yield 2;\n  }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"class D {\n\t*values() {\n\t\tyield 2;\n\t}\n}",
		);
	});

	it("does not treat a C-style pointer dereference's leading `*` as a comment opener", () => {
		const oldText = "void f() {\n  int *p = &x;\n}";
		const corrected = "void f() {\n\tint *p = &x;\n}";
		const newText = "void g() {\n  int *q = &y;\n    int *r = &z;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"void g() {\n\tint *q = &y;\n\t\tint *r = &z;\n}",
		);
	});

	it("keeps lines after an unterminated /* (a comment token inside a string) as structural evidence", () => {
		// The `/*` here is inside a string literal and never closes anywhere in
		// oldText — indent-detect's own rule treats those lines as structural
		// rather than silently swallowing the rest of the file; retarget must
		// match that rule via the same shared lexer.
		const oldText = 'const s = "/*";\nfunction f() {\n  go();\n}';
		const corrected = 'const s = "/*";\nfunction f() {\n\tgo();\n}';
		const newText = "function g() {\n  a();\n    b();\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\n\ta();\n\t\tb();\n}",
		);
	});

	it("excludes the comment interior under CRLF line endings too", () => {
		const oldText = "/**\r\n * doc\r\n */\r\nfunction f() {\r\n    go();\r\n}";
		const corrected =
			"/**\r\n  * doc\r\n  */\r\nfunction f() {\r\n   go();\r\n}";
		const newText = "function g() {\r\n    a();\r\n        b();\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function g() {\r\n   a();\r\n      b();\r\n}",
		);
	});
});
