/**
 * The census seam's own guard (#4606 S0).
 *
 * `tests/support/ast-census.ts` is the ONE place the AST governance sweeps
 * parse a source text, walk an AST, and enumerate the census files:
 *
 * - (A) `tests/config/bounded-eviction-idiom-sweep.test.ts` asks "is this an
 *   eviction program?";
 * - (B) `tests/config/bounded-container-guard.test.ts` asks "is this long-lived
 *   container bounded?";
 * - `tests/support/silent-catch-scan.ts` folds its own pre-order walk here too
 *   (#4603's copy, caught on the #4606 S0 merge).
 *
 * Each sweep keeps its own root list; they share the seam and nothing else.
 * The tests below are the three properties that make that sharing real rather
 * than nominal:
 *
 * 1. **One traversal, one module instance.** A second copy of the pre-order
 *    walk is behaviourally invisible (two identical recursions visit the same
 *    nodes in the same order), so a runtime assertion cannot see it — this is
 *    the case AGENTS.md's "prefer a runtime probe" rule excepts. The population
 *    is the seam plus its consumers, and it is derived from the child-accessor
 *    family (`children()`, `namedChildren()`, `descendants()`, `child(i)`,
 *    `childCount()`, `nextAll()`, `prevAll()`), never from a list of known-bad
 *    loop spellings: any line that reaches a node's children is a candidate,
 *    the seam admits exactly one (its own `walkAst`), and a consumer line is
 *    admitted only by a reasoned row. An unlisted site reports its file and
 *    line and fails closed, and a row whose site is gone fails too (AGENTS.md
 *    shape 69). Each consumer must also resolve the SAME module file, so a
 *    local copy that re-exports a private walk is not mistaken for the seam.
 * 2. **One parse, one walk per source text** (#3058). `parseNodes` returns the
 *    node array its single `walkAst` visit produced, checked against a kind
 *    sequence authored from the source text and the grammar — not from
 *    `walkAst`, which would agree with itself. #3058's measurement is the
 *    reason the seam exists: the predicates used to take a source STRING and
 *    re-parse and re-walk each file, once per container occurrence (~1,800
 *    whole-file passes, 9,207 MB peak RSS against 62 MB of V8 heap).
 * 3. **The `.js`-twin census rule.** `npm run build` emits a compiled `.js`
 *    beside every source `.ts` outside `tests/`, so a census that requests
 *    `.js` reads the same code twice under two identities: two occurrence
 *    rows, two content keys, and an admission that can only cover one of them.
 *    The rule is "skip a `.js` only when its `.ts` twin is on disk" — a
 *    hand-written `.mjs` tool script with no `.mts` twin stays in the census.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { censusSourceFiles, parseNodes } from "./ast-census.js";
import { readWalkedFile, relativePosix, stripSource } from "./sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SEAM = "tests/support/ast-census.ts";
const CONSUMERS = [
	"tests/config/bounded-container-guard.test.ts",
	"tests/config/bounded-eviction-idiom-sweep.test.ts",
	"tests/support/silent-catch-scan.ts",
];

/**
 * Every `SgNode` member that reaches a node's children or siblings. A walk is
 * spelled through one of these, so the population is the accessor family, with
 * no ordering requirement and no iteration token: a spelling this test never
 * names — `namedChildren().forEach(…)`, a `child(i)`/`childCount()` loop, an
 * accessor bound to a local before it is called — still lands in it.
 */
const CHILD_ACCESSOR =
	/\.(?:child|children|childCount|namedChildren|descendants|nextAll|prevAll)\b/;

/** The same family reached through a string subscript (`node["children"]()`). */
const SUBSCRIPT_ACCESSOR =
	/\[\s*["'`](?:child|children|childCount|namedChildren|descendants|nextAll|prevAll)["'`]\s*\]/;

type AccessorSite = { file: string; line: number; text: string };

/** A consumer's child-accessor site that is NOT a pre-order walk, with why. */
interface AccessorAdmission {
	file: string;
	/** Exact (whitespace-collapsed) source text of the site line. */
	text: string;
	reason: string;
}

/**
 * The classified consumer sites. Every one of them reaches children without
 * walking the tree, or walks it under a stop rule `walkAst` cannot express
 * (it stops at function boundaries, or collects one kind of declaration), so
 * folding it onto the seam would change what the sweep sees. A row is matched
 * by file and text and must match a live site: an unlisted site reds, and a
 * row that no longer describes anything reds too.
 */
const ADMITTED_ACCESSOR_SITES: readonly AccessorAdmission[] = [
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: ".namedChildren()",
		reason:
			"the second line of `!node.namedChildren().some(…)`: a kind filter over one node's children, no recursion",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: 'const key = node.field("arguments")?.namedChildren()[0];',
		reason: "indexes the first argument of a call; nothing is visited",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: 'expression = node.field("arguments")?.namedChildren()[0]?.text();',
		reason: "reads one argument's text; nothing is visited",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: "const expressionNode = root.namedChildren()[0]?.namedChildren()[0];",
		reason:
			"unwraps the single expression of a parsed key, one or two levels deep",
	},
	{
		file: "tests/config/bounded-container-guard.test.ts",
		text: '(value.field("arguments")?.namedChildren().length ?? 0) >= 2',
		reason: "measures a call's argument count; nothing is visited",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of node.children()) {",
		reason:
			"`walkOwnBody`: the stop rule excludes nested function bodies, so it is not the pre-order walk",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of current.children()) {",
		reason:
			"`nestedFunctionSpans`: records each nested function's range and stops there",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "return pattern.namedChildren().some((child: SgNode) => binding(child));",
		reason: "tests a destructuring pattern's parts for one binding name",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of node.namedChildren()) collect(child);",
		reason:
			"the scope lookup's `collect`: stops at function, block and catch boundaries",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "for (const child of scope.namedChildren()) collect(child);",
		reason: "seeds the same stopped `collect` at the scope's own children",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "return rejectionMemberOf(node.namedChildren()[0], raw, callSite);",
		reason: "unwraps a parenthesized expression to its single child",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: 'const args = node.field("arguments")?.namedChildren() ?? [];',
		reason: "reads a call's argument list; nothing is visited",
	},
	{
		file: "tests/support/silent-catch-scan.ts",
		text: "value = value.namedChildren()[0];",
		reason: "unwraps a parenthesized expression to its single child",
	},
];

/** Collapse whitespace so a row survives indentation and in-line spacing. */
function collapse(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function siteKey(file: string, text: string): string {
	return `${file}\u0000${collapse(text)}`;
}

function sourceOf(file: string): string {
	const source = readWalkedFile(path.join(REPO_ROOT, file));
	// Fail closed: a vanished member of the population is not a clean census.
	if (source === undefined)
		throw new Error(`census population member is missing: ${file}`);
	return source;
}

/**
 * Every child-accessor line in one source text. Comments are blanked (a
 * commented-out walk is not a walk) and strings are kept, because a subscript
 * spelling reaches the accessor through a string literal.
 */
function accessorSitesIn(source: string, file: string): AccessorSite[] {
	return stripSource(source, { strings: "keep" })
		.split("\n")
		.flatMap((text, index) => {
			const line = text.trim();
			return CHILD_ACCESSOR.test(line) || SUBSCRIPT_ACCESSOR.test(line)
				? [{ file, line: index + 1, text: line }]
				: [];
		});
}

function accessorSites(file: string): AccessorSite[] {
	return accessorSitesIn(sourceOf(file), file);
}

/** The census module file a consumer's import specifier resolves to. */
function resolvedCensusImports(file: string): string[] {
	const source = stripSource(sourceOf(file), { strings: "keep" });
	const targets = new Set<string>();
	for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
		const specifier = match[1] ?? "";
		if (!specifier.includes("ast-census")) continue;
		const resolved = path.resolve(
			path.dirname(path.join(REPO_ROOT, file)),
			specifier,
		);
		// `tests/` is excluded from the build, so a `.js` specifier resolves to
		// the `.ts` source: compare the file a consumer actually loads.
		const onDisk = specifier.endsWith(".js")
			? [resolved, resolved.replace(/\.js$/, ".ts")].find((candidate) =>
					fs.existsSync(candidate),
				)
			: resolved;
		if (onDisk === undefined)
			throw new Error(`${file}: census import does not resolve: ${specifier}`);
		targets.add(onDisk);
	}
	return [...targets];
}

function describeSite(site: AccessorSite): string {
	return `${site.file}:${site.line} ${site.text}`;
}

describe("one census seam for the AST sweeps (#4606 S0)", () => {
	it("both sweeps load the one seam and leave no traversal of their own", () => {
		const seamAbsolute = path.join(REPO_ROOT, SEAM);
		for (const consumer of CONSUMERS) {
			expect(
				resolvedCensusImports(consumer),
				`${consumer} must load the census seam`,
			).toContain(seamAbsolute);
		}

		// Exactly one child-accessor site in the seam, and it is the walk: a
		// private copy beside `walkAst`, or a read that hides a second
		// recursion, reds here with its own line.
		const seamSites = accessorSites(SEAM);
		expect(
			seamSites.map(describeSite),
			`${SEAM} owns exactly one pre-order traversal`,
		).toHaveLength(1);
		expect(seamSites[0]?.text).toContain("walkAst(");

		// A second walk in a consumer is the duplicate this seam exists to
		// prevent, and it is behaviourally invisible, so it is caught here.
		const consumerSites = CONSUMERS.flatMap(accessorSites);
		const rows = new Map<string, AccessorAdmission>();
		for (const row of ADMITTED_ACCESSOR_SITES) {
			const key = siteKey(row.file, row.text);
			if (rows.has(key))
				throw new Error(
					`duplicate accessor admission row: ${row.file} ${row.text}`,
				);
			rows.set(key, row);
		}
		const unclassified = consumerSites.filter(
			(site) => !rows.has(siteKey(site.file, site.text)),
		);
		expect(
			unclassified.map(describeSite),
			"a sweep may not define its own AST traversal: import walkAst from the census seam, or admit the site with a reason",
		).toEqual([]);

		// Both directions: a row whose site is gone hides the next walk written
		// on that line, so it must go with the code it described.
		const live = new Set(
			consumerSites.map((site) => siteKey(site.file, site.text)),
		);
		const stale = [...rows.values()]
			.filter((row) => !live.has(siteKey(row.file, row.text)))
			.map((row) => `${row.file} ${row.text} — ${row.reason}`);
		expect(stale, "a stale accessor admission row must go").toEqual([]);
	});

	it("classifies a second traversal whatever spelling it uses", () => {
		// Each plant is a pre-order walk written a different way; the detector
		// reads the accessor family, so none of them needs its own needle.
		const traversals = [
			"for (const child of node.children()) walkAgain(child, visit);",
			"for (const child of node.namedChildren()) walkAgain(child, visit);",
			"node.namedChildren().forEach((child) => walkAgain(child, visit));",
			"for (let index = 0; index < node.childCount(); index++) walkAgain(node.child(index), visit);",
			"node.descendants().map(visit);",
			"const kids = node.namedChildren; kids().forEach(visit);",
			'const kids = node["namedChildren"]; kids().forEach(visit);',
		];
		expect(
			traversals.map((line) => accessorSitesIn(line, "plant.ts").length),
			"every spelling of a second traversal is a candidate site",
		).toEqual(traversals.map(() => 1));

		// A node read is not a traversal: the detector classifies, it does not
		// blanket-ban `kind()`/`text()`/`field()`.
		const reads = [
			"const kind = node.kind();",
			'if (first.kind() === "identifier") return first.text();',
			"visit(node);",
		];
		expect(
			reads.flatMap((line) => accessorSitesIn(line, "plant.ts")),
			"a node read is not a traversal",
		).toEqual([]);
	});

	it("parses once and walks every node exactly once in document order", () => {
		const source = "if (a) { b(c); } else { d(); }";
		// Authored from this source text and the TypeScript grammar, NOT from
		// `walkAst`: the expected side is independent, so a walk that shrinks
		// (drops a node's last child, or its leaf punctuation) reds instead of
		// agreeing with itself.
		const expectedKinds = [
			"program",
			"if_statement",
			"if",
			"parenthesized_expression",
			"(",
			"identifier",
			")",
			"statement_block",
			"{",
			"expression_statement",
			"call_expression",
			"identifier",
			"arguments",
			"(",
			"identifier",
			")",
			";",
			"}",
			"else_clause",
			"else",
			"statement_block",
			"{",
			"expression_statement",
			"call_expression",
			"identifier",
			"arguments",
			"(",
			")",
			";",
			"}",
		];
		const nodes = parseNodes(source);
		expect(nodes.map((node) => node.kind())).toEqual(expectedKinds);

		// One walk, not two: a second traversal inside `parseNodes` returns the
		// same nodes a second time (a longer array, and repeats).
		expect(new Set(nodes).size).toBe(nodes.length);

		// Pre-order: visited in document order, so node start offsets never
		// decrease (a parent shares its first child's start). A post-order walk
		// reds here because a parent would follow a child that starts later.
		const starts = nodes.map((node) => node.range().start.index);
		for (let index = 1; index < starts.length; index++)
			expect(starts[index]).toBeGreaterThanOrEqual(starts[index - 1]!);
		const textPosition = (text: string): number =>
			nodes.findIndex((node) => node.text() === text);
		expect(textPosition("c")).toBeGreaterThan(textPosition("b"));
		expect(textPosition("c")).toBeLessThan(textPosition("d"));
	});

	it("skips a .js twin only when its .ts twin is on disk", () => {
		const fixture = setupTestEnvironment("pi-lens-ast-census-");
		try {
			const files: Record<string, string> = {
				"a.ts": "export const a = 1;\n",
				"a.js": "exports.a = 1;\n",
				"b.js": "exports.b = 1;\n",
				"c.mjs": "export const c = 1;\n",
				"c.mts": "export const c: number = 1;\n",
				"d.ts": "export const d = 1;\n",
				"nested/e.ts": "export const e = 1;\n",
				"nested/e.js": "exports.e = 1;\n",
				"x.test.ts": "// a test file, excluded by skipTests\n",
			};
			for (const [relative, content] of Object.entries(files)) {
				const target = path.join(fixture.tmpDir, relative);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content);
			}
			const census = (skipTests: boolean) =>
				censusSourceFiles([fixture.tmpDir], {
					extensions: [".ts", ".mjs", ".js"],
					skipTests,
				}).map((file) => relativePosix(fixture.tmpDir, file));

			// `a.js` and `nested/e.js` have a `.ts` twin and are the same code.
			// `b.js` is a hand-written script with no twin and stays. `c.mjs` is
			// kept: the twin rule derives `c.ts`, and `c.mjs`'s own `.d.mts`
			// declaration is excluded by `skipDeclarations`, not by this rule.
			expect(census(true)).toEqual([
				"a.ts",
				"b.js",
				"c.mjs",
				"d.ts",
				"nested/e.ts",
			]);
			expect(census(false)).toEqual([
				"a.ts",
				"b.js",
				"c.mjs",
				"d.ts",
				"nested/e.ts",
				"x.test.ts",
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it("admits a file root as its own census entry", () => {
		const fixture = setupTestEnvironment("pi-lens-ast-census-file-");
		try {
			for (const [relative, content] of Object.entries({
				"only.ts": "export const only = 1;\n",
				"twinned.ts": "export const twinned = 1;\n",
				"twinned.js": "exports.twinned = 1;\n",
				"sibling.ts": "export const sibling = 1;\n",
			})) {
				fs.writeFileSync(path.join(fixture.tmpDir, relative), content);
			}
			// A root that is a file is the census entry itself, not a directory
			// to list: `index.ts` in the live roots depends on this branch.
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "only.ts")], {
					extensions: [".ts"],
				}),
			).toEqual([path.join(fixture.tmpDir, "only.ts")]);
			// A file root goes through the `.js`-twin rule like any other entry.
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "twinned.js")], {
					extensions: [".ts", ".js"],
				}),
			).toEqual([]);
			expect(
				censusSourceFiles([path.join(fixture.tmpDir, "sibling.ts")], {
					extensions: [".ts"],
				}),
			).toEqual([path.join(fixture.tmpDir, "sibling.ts")]);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps the live census floor and never returns a compiled twin", () => {
		const roots = [
			"clients",
			"tools",
			"mcp",
			"scripts",
			"tests/support",
			"index.ts",
		].map((root) => path.join(REPO_ROOT, root));
		const files = censusSourceFiles(roots, {
			extensions: [".ts", ".mjs", ".js"],
			skipTests: true,
		});
		// Calibration: 787 files on 2026-10-18 (#4606's measurement at
		// 55b3651a7 plus the seam, on the merge with origin/master c7219849f);
		// 700 keeps a real floor while a root that stops resolving reds instead
		// of reading as clean.
		expect(files.length).toBeGreaterThanOrEqual(700);
		// The `index.ts` root is a file, not a directory: it must be listed.
		expect(files).toContain(path.join(REPO_ROOT, "index.ts"));
		const twins = files.filter(
			(file) =>
				file.endsWith(".js") && fs.existsSync(file.slice(0, -3) + ".ts"),
		);
		expect(twins.map((file) => relativePosix(REPO_ROOT, file))).toEqual([]);
	});
});
