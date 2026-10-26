/**
 * The path-containment detector (#2556): finds a hand-rolled "is this path
 * inside that root" test written over a `path.relative` result. Its state
 * table is `tests/support/path-containment-scan.test.ts`; the census over the
 * runtime trees and `tests/support/` is
 * `tests/config/path-containment-sweep.test.ts`, whose header lists the forms
 * this detector cannot see.
 *
 * The rule is derived from the seam, not from a list of spellings (AGENTS.md
 * shape 69). `clients/path-utils.ts` owns containment — `isUnderDir`,
 * `isWithinForm`, and the home-ceiling predicate `isAtOrAboveHomeDir` — and
 * every other containment test is a copy of a rule that seam already owns
 * (shape 83). The copies recur because the predicate LOOKS total and is not:
 *
 * - **#4878 F1 (HIGH, `069ff0e`):** `tests/support/vi-mock-export-gate.ts` read
 *   `path.relative(cwd, file)` with `!rel.startsWith("..")`. Across Windows
 *   drives `path.relative` returns an ABSOLUTE path, which does not start with
 *   `..`, so a file on another drive read as inside and 26 cells of
 *   `Unit tests Windows` failed. No Linux lane can see it.
 * - **#4876 review r2 F5:** `tests/config/path-identity-sweep.test.ts` reads
 *   map keys and raw `realpath` calls only, so a containment test over a
 *   relative result is outside every shipped census.
 * - **#4835 residual:** 13 live sites read a `..`-prefixed directory NAME
 *   (`..foo/x`) as outside, because they test the prefix rather than a segment.
 *
 * So the needle is a `.startsWith(<literal beginning with "..">)` whose
 * receiver is a `path.relative` result. It parses the file (`@ast-grep/napi`),
 * so a comment is never code and a string is read only by its cooked value: a
 * file that only MENTIONS the spelling (`clients/file-utils.ts` carries such a
 * comment) is not a site.
 *
 * Admitted readings, each a way the same relative value reaches the predicate:
 *
 * - `direct`: `path.relative(a, b).startsWith("..")`.
 * - `chained`: the value goes through string transforms first —
 *   `.replace(/\\/g, "/")`, `toPosix(…)`, `.split(sep).join("/")` — since none
 *   of them changes whether the text begins with a parent segment.
 * - `binding`: `const rel = path.relative(a, b); … rel.startsWith("..")`, in
 *   any number of hops (`const alias = rel`).
 *
 * A `relative` callee is the member `.relative` (or `["relative"]`) on any
 * object, or a name this file binds to one: `import { relative }`,
 * `import { relative as rel }`, `const { relative: rel } = path`, or
 * `const rel = path.relative`. Every other form refuses: a receiver this
 * reading cannot derive from a `relative` call is not a site.
 *
 * The prefix literal must BEGIN with `..` and then stop, or sit beside a
 * separator: `".."`, `"../"`, `"..\\"`, `".." + path.sep`, and a template
 * whose first fragment is one of those. `"..."` is a REST-element prefix, not
 * a parent segment (`clients/config-warn.ts`, `clients/middle-man-analysis.ts`,
 * `tests/support/sweep-kit.ts` all spell it), so it is never a site.
 */
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { cookedIdentifier, cookedString } from "./cooked-literal.js";

export interface PathContainmentSite {
	/** 0-based line of the `startsWith(…)` call that makes the site. */
	line: number;
	/**
	 * The enclosing named symbol, `Class.method` for a class member and
	 * `<module>` at file scope. A baseline row is keyed by file and anchor, so
	 * a second containment test inside an admitted function still reds.
	 */
	anchor: string;
	/** Which admitted reading matched, for messages and the state table. */
	form: string;
}

/** Wrappers that keep the value they hold (the path identity detector's set). */
const TRANSPARENT: ReadonlySet<string> = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
	"type_assertion",
]);

function named(node: SgNode): SgNode[] {
	return node
		.children()
		.filter((child) => child.isNamed() && child.kind() !== "comment");
}

function unwrap(node: SgNode): SgNode {
	let current = node;
	while (TRANSPARENT.has(String(current.kind()))) {
		const inner = named(current)[0];
		if (inner === undefined) return current;
		current = inner;
	}
	return current;
}

/** A member access: `a.b`, or `a[k]` (whose name is static only for a literal `k`). */
function isMember(node: SgNode): boolean {
	const kind = node.kind();
	return kind === "member_expression" || kind === "subscript_expression";
}

/** The static name a member reads: `a.b` and `a["b"]`, never a computed key. */
function memberName(member: SgNode): string | undefined {
	if (member.kind() === "subscript_expression") {
		const index = member.field("index");
		if (!index) return undefined;
		const value = unwrap(index);
		const text = value.text();
		if (!isQuoted(text)) return undefined;
		return cookedString(text);
	}
	const property = member.field("property");
	return property ? cookedIdentifier(property.text()) : undefined;
}

function isQuoted(text: string): boolean {
	return text.startsWith('"') || text.startsWith("'") || text.startsWith("`");
}

function argumentsOf(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	return args ? named(args) : [];
}

/** Names this file binds to `relative`: `import { relative as rel }`, `const rel = path.relative`. */
function relativeNames(root: SgNode): Set<string> {
	const names = new Set<string>(["relative"]);
	for (const specifier of root.findAll({
		rule: { kind: "import_specifier" },
	})) {
		const parts = named(specifier);
		const imported = parts[0];
		const local = parts[1] ?? parts[0];
		if (imported && local && cookedIdentifier(imported.text()) === "relative")
			names.add(cookedIdentifier(local.text()));
	}
	for (const pair of root.findAll({ rule: { kind: "pair_pattern" } })) {
		const key = pair.field("key");
		const value = pair.field("value");
		if (
			key &&
			value &&
			cookedIdentifier(key.text()) === "relative" &&
			value.kind() === "identifier"
		)
			names.add(cookedIdentifier(value.text()));
	}
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (!name || !value || name.kind() !== "identifier") continue;
		const held = unwrap(value);
		if (isMember(held) && memberName(held) === "relative")
			names.add(cookedIdentifier(name.text()));
	}
	return names;
}

/** Every declarator initializer in the file, by bound name, for the hop walk. */
function declaratorsByName(root: SgNode): Map<string, SgNode[]> {
	const byName = new Map<string, SgNode[]>();
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (!name || !value || name.kind() !== "identifier") continue;
		const key = cookedIdentifier(name.text());
		byName.set(key, [...(byName.get(key) ?? []), value]);
	}
	return byName;
}

interface Reading {
	relativeNames: ReadonlySet<string>;
	declarators: ReadonlyMap<string, readonly SgNode[]>;
}

function isRelativeCallee(node: SgNode, reading: Reading): boolean {
	const value = unwrap(node);
	if (isMember(value)) return memberName(value) === "relative";
	if (value.kind() === "identifier")
		return reading.relativeNames.has(cookedIdentifier(value.text()));
	return false;
}

/**
 * Does this expression hold (or derive from) a `path.relative` result? Walks
 * back through string transforms, call arguments and local bindings; a name
 * bound anywhere in the file counts, in every direction (fail closed: a
 * shadowing parameter and a same-named relative binding in a sibling function
 * are read as one reader, which can only add a site, never hide one).
 */
function derivesFromRelative(
	node: SgNode,
	reading: Reading,
	seen: Set<string>,
): boolean {
	const value = unwrap(node);
	switch (value.kind()) {
		case "call_expression": {
			const callee = value.field("function");
			if (callee && isRelativeCallee(callee, reading)) return true;
			// A transform keeps the value it was handed: `.replace`, `toPosix(…)`
			// and `.split(sep).join("/")` all keep a parent segment a parent
			// segment. A method this reading does not name is followed too, so an
			// unrecognised conversion is reported instead of silently dropped.
			const receiver =
				callee && isMember(callee) ? callee.field("object") : null;
			if (receiver && derivesFromRelative(receiver, reading, seen)) return true;
			return argumentsOf(value).some((argument) =>
				derivesFromRelative(argument, reading, seen),
			);
		}
		case "identifier": {
			const name = cookedIdentifier(value.text());
			if (isEnclosingParameter(value, name)) return false;
			if (seen.has(name)) return false;
			const next = new Set(seen).add(name);
			return (reading.declarators.get(name) ?? []).some((initializer) =>
				derivesFromRelative(initializer, reading, next),
			);
		}
		case "binary_expression": {
			const left = value.field("left");
			const right = value.field("right");
			return Boolean(
				(left && derivesFromRelative(left, reading, seen)) ||
				(right && derivesFromRelative(right, reading, seen)),
			);
		}
		case "template_string":
			return named(value)
				.filter((child) => child.kind() === "template_substitution")
				.flatMap((child) => named(child))
				.some((child) => derivesFromRelative(child, reading, seen));
		default:
			return false;
	}
}

/**
 * A `..`-leading prefix: `..` alone, or `..` beside a separator. Reads the
 * cooked value of a string, the first fragment of a template, and the left
 * operand of a `+` (the `".." + path.sep` spelling). `"..."` fails the third
 * character test, so the spread-syntax prefix is never read as a parent
 * segment.
 */
function isDotDotPrefix(node: SgNode): boolean {
	const value = unwrap(node);
	switch (value.kind()) {
		case "string": {
			const cooked = cookedString(value.text());
			return cooked !== undefined && dotDotLead(cooked);
		}
		case "template_string": {
			const substitutions = named(value).filter(
				(child) => child.kind() === "template_substitution",
			);
			if (substitutions.length === 0) {
				const cooked = cookedString(value.text());
				return cooked !== undefined && dotDotLead(cooked);
			}
			const head = named(value)[0];
			return head?.kind() === "string_fragment" && dotDotLead(head.text());
		}
		case "binary_expression": {
			if (value.field("operator")?.text() !== "+") return false;
			const left = value.field("left");
			return left ? isDotDotPrefix(left) : false;
		}
		default:
			return false;
	}
}

function dotDotLead(text: string): boolean {
	if (!text.startsWith("..")) return false;
	const third = text.charAt(2);
	return third === "" || third === "/" || third === "\\";
}

/** The enclosing named symbol: `Class.method`, a function-valued declarator, or `<module>`. */
function anchorOf(node: SgNode): string {
	let className: string | undefined;
	for (let current = node.parent(); current; current = current.parent()) {
		const kind = String(current.kind());
		if (kind === "class_declaration" || kind === "class") {
			className = current.field("name")?.text() ?? className;
			continue;
		}
		if (
			kind === "function_declaration" ||
			kind === "generator_function_declaration" ||
			kind === "method_definition"
		) {
			const name = current.field("name");
			if (!name) continue;
			const base = cookedIdentifier(name.text());
			return className ? `${className}.${base}` : base;
		}
		// A `const name = () => {…}` binds a symbol; a `const rel = path.relative(…)`
		// does not, so a site inside a value initializer keeps walking out to the
		// function that owns it.
		if (kind === "variable_declarator") {
			const value = current.field("value");
			const name = current.field("name");
			if (!name || !value || !NAME_BINDING_VALUES.has(String(value.kind())))
				continue;
			return className ? `${className}.${name.text()}` : name.text();
		}
	}
	return "<module>";
}

/** Function-valued declarator initializers, whose name is the symbol's name. */
const NAME_BINDING_VALUES: ReadonlySet<string> = new Set([
	"arrow_function",
	"function_expression",
	"generator_function",
]);

/** The names a formal-parameter list introduces, by position. */
function parameterNames(fn: SgNode): string[] {
	const parameters = fn.field("parameters");
	if (!parameters) return [];
	return named(parameters).map((parameter) => {
		const inner =
			parameter.field("pattern") ??
			parameter.field("left") ??
			parameter.field("name") ??
			parameter;
		return cookedIdentifier(inner.text());
	});
}

/**
 * True when `name` is a parameter of one of `use`'s enclosing functions. A
 * parameter is a caller-supplied spelling, not a `path.relative` result: the
 * hand-off through a call argument is outside this needle (header, known
 * missed shapes), and reading a same-named binding from a sibling function
 * would be the accident this guard exists to stop.
 */
function isEnclosingParameter(use: SgNode, name: string): boolean {
	for (let current = use.parent(); current; current = current.parent()) {
		if (!CALLABLE_KINDS.has(String(current.kind()))) continue;
		if (parameterNames(current).includes(name)) return true;
	}
	return false;
}

const CALLABLE_KINDS: ReadonlySet<string> = new Set([
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"generator_function",
	"method_definition",
	"arrow_function",
]);

/** Every containment test over a `path.relative` result in one TypeScript source. */
export function scanPathContainmentSites(
	source: string,
): PathContainmentSite[] {
	const root = parse(Lang.TypeScript, source).root();
	const reading: Reading = {
		relativeNames: relativeNames(root),
		declarators: declaratorsByName(root),
	};
	const sites: PathContainmentSite[] = [];
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee || !isMember(callee)) continue;
		if (memberName(callee) !== "startsWith") continue;
		const receiver = callee.field("object");
		const prefix = argumentsOf(call)[0];
		if (!receiver || !prefix) continue;
		if (!isDotDotPrefix(prefix)) continue;
		if (!derivesFromRelative(receiver, reading, new Set())) continue;
		const held = unwrap(receiver);
		const form =
			held.kind() === "identifier"
				? "binding"
				: held.kind() === "call_expression"
					? "direct or chained"
					: "derived value";
		sites.push({ line: call.range().start.line, anchor: anchorOf(call), form });
	}
	return sites.sort((a, b) => a.line - b.line);
}
