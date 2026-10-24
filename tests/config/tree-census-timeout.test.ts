/**
 * #4828: every tests/config census that walks the repo tree carries a timeout
 * budget. A census declared with vitest's 5 s default reds on the Windows unit
 * leg (`Unit tests Windows`): the walk costs several times its Linux time
 * there (the 2026-10-24 #4823 run timed out `pi-mock-importer-sweep` at
 * 5000 ms, whose Linux time is 711 ms).
 *
 * The census is a test whose callback calls a tree walker, or reads a binding
 * that a walker produced at module or describe scope (a suite-level `files`
 * list is a walk even though the callback never names the walker). A census
 * with a third argument already carries a budget and is admitted whatever its
 * value; a census with the default two arguments is refused. The fix is the
 * shared `TREE_WALK_TIMEOUT_MS` (`tests/support/test-timeout-scale.ts`), never
 * a per-file number.
 *
 * Walkers are the calls whose result is a whole-tree population
 * (`listSourceFiles`, `censusSourceFiles`, `listTrackedFiles`) and a
 * `git ls-files` spawn argument. Detection reads the parsed AST, so a walker
 * named in a comment, a title or an expectation does not make a census.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { parseRoot } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_DIR = path.join(ROOT, "tests", "config");

const WALKERS = new Set([
	"listSourceFiles",
	"censusSourceFiles",
	"listTrackedFiles",
]);
const DECLARATION_CALLEE = /^(it|test)(\.\w+)*$/;
const EACH_CALLEE = /^(it|test)\.each$/;

function namedArgs(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	if (!args) return [];
	const named = args.children().filter((node) => node.isNamed());
	return named.filter((node) => node.kind() !== "comment");
}

/** Module scope, or the body of a `describe` callback. */
function atSuiteScope(node: SgNode): boolean {
	let owner = node.parent();
	while (owner) {
		if (
			owner.kind() === "arrow_function" ||
			owner.kind() === "function_expression" ||
			owner.kind() === "function_declaration"
		) {
			const call = owner.parent()?.parent();
			return (
				call?.kind() === "call_expression" &&
				/^describe(\.\w+)?$/.test(call.field("function")?.text() ?? "")
			);
		}
		owner = owner.parent();
	}
	return true;
}

/**
 * A directory walk that recurses: a function that reads a directory and calls a
 * function declared inside it (the shape of `git-fixture-governance`'s
 * `walkFiles`, whose nested `walk` descends into itself). A loop over one
 * directory's entries is not a tree walk.
 */
function recursiveDirectoryWalk(node: SgNode): boolean {
	if (node.kind() !== "function_declaration") return false;
	const declared = new Set(
		node
			.findAll({ rule: { kind: "function_declaration" } })
			.map((fn) => fn.field("name")?.text() ?? ""),
	);
	const calls = node.findAll({ rule: { kind: "call_expression" } });
	const readsDirectory = calls.some((call) =>
		/(^|\.)readdir(Sync)?$/.test(
			(call.field("function")?.text() ?? "").replace(/\s/g, ""),
		),
	);
	const descends = calls.some((call) =>
		declared.has(call.field("function")?.text() ?? ""),
	);
	return readsDirectory && descends;
}

/** Does this subtree call a whole-tree walker, or spawn `git ls-files`? */
function walksTree(node: SgNode): boolean {
	const walks = node
		.findAll({ rule: { kind: "call_expression" } })
		.some((call) => WALKERS.has(call.field("function")?.text() ?? ""));
	return (
		walks ||
		recursiveDirectoryWalk(node) ||
		// `git ls-files` only as a spawn argument (an array element), never as
		// a literal in an expectation or a fixture.
		node
			.findAll({ rule: { kind: "string" } })
			.some(
				(text) =>
					text.parent()?.kind() === "array" && text.text().includes("ls-files"),
			)
	);
}

interface Census {
	title: string;
	argCount: number;
}

/** Every census declaration in one test file's source (one parse). */
function censuses(source: string): Census[] {
	const root = parseRoot(source);
	// A suite-scope binding is a walk when its initializer walks, or reads a walk
	// binding (`const walked = files.map(...)`); iterate to a fixed point. A
	// local in a case or a helper is not the census.
	const decls = root
		.findAll({
			rule: {
				any: [
					{ kind: "variable_declarator" },
					{ kind: "function_declaration" },
				],
			},
		})
		.filter((decl) => atSuiteScope(decl))
		.map((decl) => ({ name: decl.field("name")?.text() ?? "", decl }))
		.filter((entry) => entry.name !== "");
	const walked = new Set<string>();
	let grown = true;
	while (grown) {
		grown = false;
		for (const { name, decl } of decls) {
			if (walked.has(name)) continue;
			const reads = decl
				.findAll({ rule: { kind: "identifier" } })
				.some((id) => walked.has(id.text()));
			if (walksTree(decl) || reads) {
				walked.add(name);
				grown = true;
			}
		}
	}
	const found: Census[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee) continue;
		// `it.each(table)(title, fn)`: the declaration is the outer call.
		const eachTable =
			callee.kind() === "call_expression" &&
			EACH_CALLEE.test(callee.field("function")?.text() ?? "");
		if (!eachTable && !DECLARATION_CALLEE.test(callee.text())) continue;
		const args = namedArgs(call);
		if (args.length < 2) continue;
		const body = args[1];
		const census =
			walksTree(body) ||
			body
				.findAll({ rule: { kind: "identifier" } })
				.some((id) => walked.has(id.text()));
		if (census) found.push({ title: args[0].text(), argCount: args.length });
	}
	return found;
}

describe("tree census timeout (#4828)", () => {
	it("plants: refuses a default-budget walk and admits a budgeted one, a binding walk, and prose", () => {
		// #4828: the four members were red on Windows with the default 5 s budget.
		const defaultBudget = (source: string) =>
			censuses(source)
				.filter((census) => census.argCount === 2)
				.map((census) => census.title);
		expect(
			defaultBudget(`it("direct", () => { listSourceFiles(ROOT); });`),
		).toEqual(['"direct"']);
		expect(
			defaultBudget(
				`const files = listSourceFiles(ROOT);\nit("via binding", () => { expect(files.length).toBeGreaterThan(0); });`,
			),
		).toEqual(['"via binding"']);
		expect(
			defaultBudget(
				`it("budgeted", () => { listSourceFiles(ROOT); }, TREE_WALK_TIMEOUT_MS);`,
			),
		).toEqual([]);
		expect(
			defaultBudget(
				`it("prose", () => { /* listSourceFiles(ROOT) */ const s = "git ls-files"; expect(s).toBe("x"); });`,
			),
		).toEqual([]);
	});

	it(
		"every tests/config census with a tree walk carries a timeout budget",
		async () => {
			const files = listSourceFiles(CONFIG_DIR, {
				extensions: [".ts"],
				skipTests: false,
			}).filter((file) => file.endsWith(".test.ts"));
			// Calibration 2026-10-25: 141 tests/config test files; half rounds to 70.
			assertNonEmptyScan("tests/config test files", files.length, 70);
			const flagged: string[] = [];
			let census = 0;
			for (const { file, source } of readWalkedFiles(files)) {
				const rel = relativePosix(ROOT, file);
				for (const found of censuses(source)) {
					census += 1;
					if (found.argCount === 2) flagged.push(`${rel}: ${found.title}`);
				}
				// Shape 81: turn the loop once per file so each parsed native tree is
				// freed before the next file is parsed.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			// Calibration 2026-10-25: 121 census tests declared the default budget
			// before #4828, and every census carries a budget after it; the floor
			// of 30 keeps a dead walk from reading as clean.
			assertNonEmptyScan("tree census tests", census, 30);
			expect(flagged).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});
