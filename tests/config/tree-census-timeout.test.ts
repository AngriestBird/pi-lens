/**
 * #4828: every tests/config census that walks the repo tree carries a timeout
 * budget. A census declared with vitest's 5 s default reds on the Windows unit
 * leg (`Unit tests Windows`): the walk costs several times its Linux time
 * there (the 2026-10-24 #4823 run timed out `pi-mock-importer-sweep` at
 * 5000 ms, whose Linux time is 711 ms).
 *
 * A census is a test whose callback walks the tree, or reads a binding that a
 * walk produced at module or describe scope (a suite-level `files` list is a
 * walk even though the callback never names the walker), or an `it.each` /
 * `it.for` over such a table. A census with a third argument carries a budget
 * and is admitted whatever its value; a census with the default two arguments
 * is refused. The fix is the shared `TREE_WALK_TIMEOUT_MS`
 * (`tests/support/test-timeout-scale.ts`), never a per-file number.
 *
 * The detector admits known-good forms and refuses the rest (AGENTS.md shape
 * 69, shape 85). It reads the parsed AST, so a name in a comment, a title or
 * an expectation makes nothing.
 *
 * - Test declaration: a call whose callee chain starts at a binding of
 *   vitest's `it` or `test` (derived from the file's `import ... from
 *   "vitest"` specifiers, aliases and a namespace import included), through
 *   any member, string-subscript or call segments (`.only`, `.skipIf(c)`,
 *   `.each(table)`).
 * - Unclassified test callee: a call at module or describe scope whose second
 *   argument is a function that walks the tree and whose callee root is
 *   neither a declaration nor a vitest suite. It is a census too, so a
 *   wrapper, an `it.extend` alias or an un-imported `it` is refused rather
 *   than skipped.
 * - Walker: a call whose callee is a binding of `listSourceFiles`,
 *   `censusSourceFiles` or `listTrackedFiles` (import aliases, `const`
 *   aliases and destructured renames included) or a member call of one of
 *   those names, plus a recognised spawn call (`gitExecFileSync`,
 *   `execFileSync`, `execFile`, `spawnSync`, `spawn`, aliases included) given
 *   `ls-files` as a string, an array element, or a binding of either.
 *
 * Not read (accepted residual): a walker reached only through a helper in
 * another module.
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
const SPAWNERS = new Set([
	"gitExecFileSync",
	"execFileSync",
	"execFile",
	"spawnSync",
	"spawn",
]);
const DECLARATIONS = new Set(["it", "test"]);
const SUITES = new Set(["describe", "suite"]);
const TABLE_MODIFIERS = new Set(["each", "for"]);
const FUNCTION_KINDS = new Set<string>([
	"arrow_function",
	"function_expression",
	"function",
]);

/** The names one file binds, derived from its imports and aliases. */
interface Scope {
	/** Local names bound to vitest's `it` / `test`. */
	declarations: Set<string>;
	/** Local names bound to vitest's `describe` / `suite`. */
	suites: Set<string>;
	/** Local names bound to the whole vitest namespace (`import * as v`). */
	namespaces: Set<string>;
	/** Local names that call a whole-tree walker. */
	walkers: Set<string>;
	/** Local names that spawn a process. */
	spawners: Set<string>;
	/** Bindings whose value mentions `ls-files` (an array or a string). */
	lsFiles: Set<string>;
}

function namedArgs(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	if (!args) return [];
	const named = args.children().filter((node) => node.isNamed());
	return named.filter((node) => node.kind() !== "comment");
}

function unquote(text: string): string {
	return text.replace(/^["'`]|["'`]$/g, "");
}

/** Does this node (or a segment of it) name `ls-files`? */
function mentionsLsFiles(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.lsFiles.has(node.text());
	if (node.kind() === "string") return /\bls-files\b/.test(node.text());
	if (node.kind() !== "array") return false;
	return node
		.findAll({ rule: { kind: "string" } })
		.some((text) => unquote(text.text()) === "ls-files");
}

/** Build the per-file name table from its imports and aliases. */
function scopeOf(root: SgNode): Scope {
	const scope: Scope = {
		declarations: new Set(),
		suites: new Set(),
		namespaces: new Set(),
		walkers: new Set(WALKERS),
		spawners: new Set(SPAWNERS),
		lsFiles: new Set(),
	};
	for (const statement of root.findAll({
		rule: { kind: "import_statement" },
	})) {
		const vitest =
			unquote(statement.field("source")?.text() ?? "") === "vitest";
		for (const specifier of statement.findAll({
			rule: { kind: "import_specifier" },
		})) {
			const name = specifier.field("name")?.text() ?? "";
			const local = specifier.field("alias")?.text() ?? name;
			if (vitest && DECLARATIONS.has(name)) scope.declarations.add(local);
			if (vitest && SUITES.has(name)) scope.suites.add(local);
			if (WALKERS.has(name)) scope.walkers.add(local);
			if (SPAWNERS.has(name)) scope.spawners.add(local);
		}
		if (vitest) {
			for (const space of statement.findAll({
				rule: { kind: "namespace_import" },
			})) {
				const local = space.find({ rule: { kind: "identifier" } })?.text();
				if (local) scope.namespaces.add(local);
			}
		}
	}
	const declarators = root.findAll({ rule: { kind: "variable_declarator" } });
	let grown = true;
	while (grown) {
		grown = false;
		for (const declarator of declarators) {
			const name = declarator.field("name");
			const value = declarator.field("value");
			if (!name || !value) continue;
			const add = (set: Set<string>, local: string) => {
				if (local && !set.has(local)) {
					set.add(local);
					grown = true;
				}
			};
			if (name.kind() === "identifier") {
				if (walkerRef(value, scope)) add(scope.walkers, name.text());
				if (spawnerRef(value, scope)) add(scope.spawners, name.text());
				if (mentionsLsFiles(value, scope)) add(scope.lsFiles, name.text());
			} else if (name.kind() === "object_pattern") {
				// `const { listSourceFiles: walk } = kit;`
				for (const pair of name.findAll({ rule: { kind: "pair_pattern" } })) {
					const key = unquote(pair.field("key")?.text() ?? "");
					const local = pair.field("value")?.text() ?? "";
					if (WALKERS.has(key)) add(scope.walkers, local);
					if (SPAWNERS.has(key)) add(scope.spawners, local);
				}
			}
		}
	}
	return scope;
}

/** The property name of `obj.name` or `obj["name"]`, else undefined. */
function propertyName(node: SgNode): string | undefined {
	if (node.kind() === "member_expression")
		return node.field("property")?.text();
	if (node.kind() === "subscript_expression") {
		const index = node.field("index");
		return index?.kind() === "string" ? unquote(index.text()) : undefined;
	}
	return undefined;
}

/** Is this expression a reference to a walker (a binding or a member)? */
function walkerRef(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.walkers.has(node.text());
	const property = propertyName(node);
	return property !== undefined && WALKERS.has(property);
}

function spawnerRef(node: SgNode, scope: Scope): boolean {
	if (node.kind() === "identifier") return scope.spawners.has(node.text());
	const property = propertyName(node);
	return property !== undefined && SPAWNERS.has(property);
}

/**
 * The root a callee chain starts at: `it` for `it.skipIf(c).each(t)`, a
 * `vitest:it` for the namespaced `v.it`, undefined for a chain that does not
 * start at a name (`(a ? b : c)(...)`).
 */
function rootOf(node: SgNode, scope: Scope): string | undefined {
	switch (node.kind()) {
		case "identifier":
			return node.text();
		case "call_expression": {
			const fn = node.field("function");
			return fn ? rootOf(fn, scope) : undefined;
		}
		case "member_expression":
		case "subscript_expression": {
			const object = node.field("object");
			if (!object) return undefined;
			if (object.kind() === "identifier" && scope.namespaces.has(object.text()))
				return `vitest:${propertyName(node) ?? ""}`;
			return rootOf(object, scope);
		}
		default:
			return undefined;
	}
}

function isDeclarationRoot(root: string | undefined, scope: Scope): boolean {
	if (root === undefined) return false;
	if (root.startsWith("vitest:")) return DECLARATIONS.has(root.slice(7));
	return scope.declarations.has(root);
}

function isSuiteRoot(root: string | undefined, scope: Scope): boolean {
	if (root === undefined) return false;
	if (root.startsWith("vitest:")) return SUITES.has(root.slice(7));
	return scope.suites.has(root);
}

/** The table argument lists of every `.each(...)` / `.for(...)` in a chain. */
function tableArguments(callee: SgNode): SgNode[] {
	const tables: SgNode[] = [];
	let node: SgNode | null = callee;
	while (node) {
		if (node.kind() === "call_expression") {
			const fn: SgNode | null = node.field("function");
			const modifier = fn ? propertyName(fn) : undefined;
			const args = node.field("arguments");
			if (modifier !== undefined && TABLE_MODIFIERS.has(modifier) && args)
				tables.push(args);
			node = fn ?? null;
		} else if (
			node.kind() === "member_expression" ||
			node.kind() === "subscript_expression"
		) {
			node = node.field("object");
		} else node = null;
	}
	return tables;
}

/** Module scope, or the body of a `describe` callback. */
function atSuiteScope(node: SgNode, scope: Scope): boolean {
	let owner = node.parent();
	while (owner) {
		if (
			owner.kind() === "arrow_function" ||
			owner.kind() === "function_expression" ||
			owner.kind() === "function_declaration"
		) {
			const call = owner.parent()?.parent();
			const fn = call?.kind() === "call_expression" && call.field("function");
			return !!fn && isSuiteRoot(rootOf(fn, scope), scope);
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
function walksTree(node: SgNode, scope: Scope): boolean {
	const calls = node.findAll({ rule: { kind: "call_expression" } });
	return (
		calls.some((call) => {
			const fn = call.field("function");
			if (!fn) return false;
			if (walkerRef(fn, scope)) return true;
			// `git ls-files` only as an argument of a recognised spawn call, never
			// as a literal in an expectation or a fixture.
			return (
				spawnerRef(fn, scope) &&
				namedArgs(call).some((arg) => mentionsLsFiles(arg, scope))
			);
		}) || recursiveDirectoryWalk(node)
	);
}

interface Census {
	title: string;
	argCount: number;
	/** `declaration`, or `unclassified` for a test-shaped call the detector
	 *  could not trace to a vitest `it`/`test` binding. */
	how: "declaration" | "unclassified";
}

/** Every census declaration in one test file's source (one parse). */
function censuses(source: string): Census[] {
	const root = parseRoot(source);
	const scope = scopeOf(root);
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
		.filter((decl) => atSuiteScope(decl, scope))
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
			if (walksTree(decl, scope) || reads) {
				walked.add(name);
				grown = true;
			}
		}
	}
	const walks = (node: SgNode) =>
		walksTree(node, scope) ||
		node
			.findAll({ rule: { kind: "identifier" } })
			.some((id) => walked.has(id.text()));
	const found: Census[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee) continue;
		const args = namedArgs(call);
		if (args.length < 2) continue;
		const calleeRoot = rootOf(callee, scope);
		const body = args[1];
		if (isDeclarationRoot(calleeRoot, scope)) {
			// `it.each(table)(title, fn)`: the table is walked even when the case
			// never names it (its rows are the walked population).
			if (walks(body) || tableArguments(callee).some(walks))
				found.push({
					title: args[0].text(),
					argCount: args.length,
					how: "declaration",
				});
			continue;
		}
		// Fail closed: a test-shaped call the detector cannot trace to a vitest
		// binding that walks the tree is a census, not a skip.
		if (
			!isSuiteRoot(calleeRoot, scope) &&
			FUNCTION_KINDS.has(String(body.kind())) &&
			atSuiteScope(call, scope) &&
			walks(body)
		)
			found.push({
				title: args[0].text(),
				argCount: args.length,
				how: "unclassified",
			});
	}
	return found;
}

describe("tree census timeout (#4828)", () => {
	// Recurrence (#4828 review r1 F1, F6): the first detector listed `it.each`
	// and an array-element `ls-files`, so an `it.skipIf` census, an aliased
	// walker and an `it.each` over a walked table were not seen, and an
	// `expect(["ls-files"])` fixture was read as a walk.
	const defaultBudget = (source: string) =>
		censuses(source)
			.filter((census) => census.argCount === 2)
			.map((census) => census.title);
	const VITEST = 'import { it, test, describe } from "vitest";\n';
	const KIT = 'import { listSourceFiles } from "../support/sweep-kit.js";\n';

	it("plants: refuses a default-budget walk and admits a budgeted one, a binding walk, and prose", () => {
		// #4828: the four members were red on Windows with the default 5 s budget.
		expect(
			defaultBudget(`${VITEST}it("direct", () => { listSourceFiles(ROOT); });`),
		).toEqual(['"direct"']);
		expect(
			defaultBudget(
				`${VITEST}const files = listSourceFiles(ROOT);\nit("via binding", () => { expect(files.length).toBeGreaterThan(0); });`,
			),
		).toEqual(['"via binding"']);
		expect(
			defaultBudget(
				`${VITEST}it("budgeted", () => { listSourceFiles(ROOT); }, TREE_WALK_TIMEOUT_MS);`,
			),
		).toEqual([]);
		expect(
			defaultBudget(
				`${VITEST}it("prose", () => { /* listSourceFiles(ROOT) */ const s = "git ls-files"; expect(s).toBe("x"); });`,
			),
		).toEqual([]);
	});

	it.each([
		["it.skipIf", 'it.skipIf(cond)("c", () => { listSourceFiles(ROOT); });'],
		["it.runIf", 'it.runIf(cond)("c", () => { listSourceFiles(ROOT); });'],
		[
			"test.skipIf",
			'test.skipIf(cond)("c", () => { listSourceFiles(ROOT); });',
		],
		["it.only", 'it.only("c", () => { listSourceFiles(ROOT); });'],
		[
			"it chained",
			'it.concurrent.only("c", () => { listSourceFiles(ROOT); });',
		],
		["it subscript", 'it["only"]("c", () => { listSourceFiles(ROOT); });'],
		[
			"it.each over an inline walk",
			'it.each(listSourceFiles(ROOT))("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"it.each over a walked table the body never names",
			'const table = listSourceFiles(ROOT);\nit.each(table)("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"it.skipIf then it.each over a walked table",
			'const table = listSourceFiles(ROOT);\nit.skipIf(cond).each(table)("c", (file) => { expect(file).toBeTruthy(); });',
		],
		[
			"an aliased vitest import",
			'import { it as check } from "vitest";\ncheck("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"a namespace vitest import",
			'import * as v from "vitest";\nv.it.skipIf(cond)("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"an unclassified test wrapper",
			'censusTest("c", () => { listSourceFiles(ROOT); });',
		],
		[
			"a walker alias import",
			'import { listSourceFiles as walkTree } from "../support/sweep-kit.js";\nit("c", () => { walkTree(ROOT); });',
		],
		[
			"a walker namespace member",
			'import * as kit from "../support/sweep-kit.js";\nit("c", () => { kit.listSourceFiles(ROOT); });',
		],
		[
			"a walker bound to a const",
			'const walk = listSourceFiles;\nit("c", () => { walk(ROOT); });',
		],
		[
			"a walker destructured under a new name",
			'import * as kit from "../support/sweep-kit.js";\nconst { listSourceFiles: walk } = kit;\nit("c", () => { walk(ROOT); });',
		],
		[
			"a git ls-files spawn",
			'it("c", () => { gitExecFileSync("git", ["ls-files", "-z"]); });',
		],
		[
			"an aliased child_process spawn of git ls-files",
			'import { execFileSync as run } from "node:child_process";\nit("c", () => { run("git", ["ls-files"]); });',
		],
	])("plants: refuses a default-budget census through %s", (_name, body) => {
		const source = `${VITEST}${KIT}${body}`;
		expect(defaultBudget(source)).toEqual(['"c"']);
		// The same spelling with a third argument is still seen and is admitted.
		const budgeted = source.replace(/\}\);\s*$/, "}, TREE_WALK_TIMEOUT_MS);");
		expect(budgeted).not.toBe(source);
		expect(censuses(budgeted)).toHaveLength(1);
		expect(defaultBudget(budgeted)).toEqual([]);
	});

	it.each([
		[
			"a suite alias",
			'import { describe as group } from "vitest";\ngroup("s", () => { listSourceFiles(ROOT); });',
		],
		["a describe body", 'describe("s", () => { listSourceFiles(ROOT); });'],
		[
			"a nested helper call inside a budgeted case",
			'it("c", () => { run(x, () => listSourceFiles(ROOT)); }, TREE_WALK_TIMEOUT_MS);',
		],
		[
			"an ls-files literal inside an expectation",
			'it("c", () => { expect(["ls-files"]).toEqual(["ls-files"]); });',
		],
		[
			"an ls-files array passed to a non-spawn call",
			'it("c", () => { record(["ls-files", "-z"]); });',
		],
		[
			"a walker named only in a string",
			'it("c", () => { const s = "listSourceFiles(ROOT)"; expect(s).toBe("x"); });',
		],
	])("plants: admits %s", (_name, body) => {
		expect(defaultBudget(`${VITEST}${KIT}${body}`)).toEqual([]);
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
			// Calibration 2026-10-25: 151 census tests declared (121 carried the
			// default budget before #4828; every one carries a budget after it). The
			// floor is the measured count, shrink-only: a regression in binding
			// propagation (measured 51) or the `it.each` table branch (measured 148)
			// drops the count and reds here, where a floor of 30 stayed green.
			assertNonEmptyScan("tree census tests", census, 151);
			expect(flagged).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});
