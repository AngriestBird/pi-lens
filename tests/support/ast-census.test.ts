/**
 * The census seam's own guard (#4606 S0).
 *
 * `tests/support/ast-census.ts` is the ONE place the two AST governance sweeps
 * parse a source text, walk an AST, and enumerate the census files:
 *
 * - (A) `tests/config/bounded-eviction-idiom-sweep.test.ts` asks "is this an
 *   eviction program?";
 * - (B) `tests/config/bounded-container-guard.test.ts` asks "is this long-lived
 *   container bounded?".
 *
 * Each sweep keeps its own root list; they share the seam and nothing else.
 * The tests below are the three properties that make that sharing real rather
 * than nominal:
 *
 * 1. **One traversal, one module instance.** A second copy of the pre-order
 *    walk is behaviourally invisible (two identical recursions visit the same
 *    nodes in the same order), so a runtime assertion cannot see it — this is
 *    the case AGENTS.md's "prefer a runtime probe" rule excepts. The population
 *    is the seam plus its two consumers, and every traversal site in it is
 *    classified: exactly one, in the seam's `walkAst`. An unclassified hit
 *    reports its file and line and fails closed. Each consumer must also
 *    resolve the SAME module file, so a local copy that re-exports a private
 *    walk is not mistaken for the seam.
 * 2. **One parse, one walk per source text** (#3058). `parseNodes` returns the
 *    node array its single `walkAst` visit produced, and each node appears
 *    exactly once: a second walk inside `parseNodes` doubles the visit count
 *    and reds. That #3058 measurement is the reason the seam exists — the
 *    predicates used to take a source STRING and re-parse and re-walk each
 *    file, once per container occurrence (~1,800 whole-file passes, 9,207 MB
 *    peak RSS against 62 MB of V8 heap).
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
import type { SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	censusSourceFiles,
	parseNodes,
	parseRoot,
	walkAst,
} from "./ast-census.js";
import { readWalkedFile, relativePosix, stripSource } from "./sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SEAM = "tests/support/ast-census.ts";
const CONSUMERS = [
	"tests/config/bounded-container-guard.test.ts",
	"tests/config/bounded-eviction-idiom-sweep.test.ts",
];

/**
 * A pre-order traversal of an AST node's direct children. `children()` and
 * `descendants()` cover the two shapes `@ast-grep/napi` offers directly; a
 * recursive `.namedChildren()` loop is the same traversal spelled through the
 * named-only accessor, so the loop form is part of the needle rather than a
 * residual (a bare `namedChildren()[0]` field read is not a walk).
 */
const TRAVERSAL_NEEDLE =
	/\.(?:children\(\)|descendants\(\))|(?:for\s*\(|\.forEach\(|\.map\(|\.reduce\().*\.namedChildren\(/;

type TraversalSite = { file: string; line: number; text: string };

function sourceOf(file: string): string {
	const source = readWalkedFile(path.join(REPO_ROOT, file));
	// Fail closed: a vanished member of the population is not a clean census.
	if (source === undefined)
		throw new Error(`census population member is missing: ${file}`);
	return source;
}

function traversalSites(file: string): TraversalSite[] {
	return stripSource(sourceOf(file))
		.split("\n")
		.flatMap((text, index) =>
			TRAVERSAL_NEEDLE.test(text)
				? [{ file, line: index + 1, text: text.trim() }]
				: [],
		);
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

function describeSite(site: TraversalSite): string {
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

		const seamSites = traversalSites(SEAM);
		const consumerSites = CONSUMERS.flatMap(traversalSites);

		// A second walk in a consumer is the duplicate this seam exists to
		// prevent, and it is behaviourally invisible, so it is caught here.
		expect(
			consumerSites.map(describeSite),
			"a sweep may not define its own AST traversal: import walkAst from the census seam",
		).toEqual([]);
		// Exactly one traversal in the seam. A second one (a private copy beside
		// `walkAst`) reds here with its own line.
		expect(
			seamSites.map(describeSite),
			`${SEAM} owns exactly one pre-order traversal`,
		).toHaveLength(1);
		expect(seamSites[0]?.file).toBe(SEAM);
	});

	it("parses once and walks every node exactly once in document order", () => {
		const source = "if (a) { b(c); } else { d(); }";
		const root = parseRoot(source);
		const walked: SgNode[] = [];
		walkAst(root, (node) => walked.push(node));

		// One walk, not two: a second traversal inside `parseNodes` would return
		// the same nodes a second time (a longer array, and repeats).
		const nodes = parseNodes(source);
		expect(nodes.length).toBe(walked.length);
		expect(new Set(nodes).size).toBe(nodes.length);
		expect(nodes.map((node) => node.kind())).toEqual(
			walked.map((node) => node.kind()),
		);
		expect(nodes[0]?.kind()).toBe("program");

		// Pre-order: visited in document order, so node start offsets never
		// decrease (a parent shares its first child's start). A post-order walk
		// reds here because a parent would follow a child that starts later.
		const starts = walked.map((node) => node.range().start.index);
		for (let index = 1; index < starts.length; index++)
			expect(starts[index]).toBeGreaterThanOrEqual(starts[index - 1]!);
		const textPosition = (text: string): number =>
			walked.findIndex((node) => node.text() === text);
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
		// Calibration: 785 files on 2026-10-18 (#4606's measurement at
		// 55b3651a7); 700 keeps a real floor while a root that stops resolving
		// reds instead of reading as clean.
		expect(files.length).toBeGreaterThanOrEqual(700);
		const twins = files.filter(
			(file) =>
				file.endsWith(".js") && fs.existsSync(file.slice(0, -3) + ".ts"),
		);
		expect(twins.map((file) => relativePosix(REPO_ROOT, file))).toEqual([]);
	});
});
