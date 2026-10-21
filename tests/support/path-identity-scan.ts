/**
 * The path identity detector (#4689): finds the two code shapes that derive a
 * file's identity outside `clients/path-utils.ts`. Its state table, one named
 * case per admitted form and per plant, is `tests/support/path-identity-scan.test.ts`;
 * the census over `clients/` is `tests/config/path-identity-sweep.test.ts`,
 * whose header lists the shapes this detector cannot see.
 *
 * The rule is derived from the seam, not from a list of spellings (AGENTS.md
 * shape 69). The detector parses the file (`@ast-grep/napi`), so a comment is
 * never code and a string is read only by its cooked value.
 *
 * - `raw-realpath`: any name whose cooked text is `realpath` or
 *   `realpathSync` (an identifier, a property, a shorthand or destructured
 *   key, an import or export specifier), and any string literal whose cooked
 *   value is one of them (`fs["realpathSync"]`, `spawn("realpath")`). A
 *   string the reader cannot cook fails closed as a site. Every reach of the
 *   kernel's realpath names one of the two, whichever binding carries it.
 * - `path-resolve-keyed`: a resolve value in a key position. A resolve value
 *   is a call of a member `.resolve` (or `["resolve"]`: a member read
 *   through a bracket with a literal key is that member, here and for every
 *   method below) or of a name bound to resolve in this
 *   file, an uncalled reference to one (a mapper), or a name this file binds
 *   to such a call (one hop). A key position is the first argument of
 *   `.set/.get/.has/.delete/.add`, the second of `<method>.call(…)`, a
 *   subscript index, or an element reached through arrays, spreads, mappers
 *   and arrow bodies inside `new Map/Set/WeakMap/WeakSet(…)`. A type cast,
 *   a non-null assertion or parentheses do not change the value; any other
 *   call around the resolve does, and decides the key itself.
 */
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { cookedIdentifier, cookedString } from "./cooked-literal.js";

export type PathIdentityNeedle = "raw-realpath" | "path-resolve-keyed";

export interface PathIdentitySite {
	needle: PathIdentityNeedle;
	/** 0-based line of the node that made the site. */
	line: number;
	/** Which admitted form matched, for messages and the state table. */
	form: string;
}

const REALPATH_NAMES: ReadonlySet<string> = new Set([
	"realpath",
	"realpathSync",
]);

const NAME_KINDS: ReadonlySet<string> = new Set([
	"identifier",
	"property_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
]);

const KEY_METHODS: ReadonlySet<string> = new Set([
	"set",
	"get",
	"has",
	"delete",
	"add",
]);

const KEYED_COLLECTIONS: ReadonlySet<string> = new Set([
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
]);

/** Wrappers that keep the value they hold: spelling, not a key decision. */
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

/** A literal's single cooked value, or `undefined` when it has none. */
function literalValue(node: SgNode): string | undefined {
	const text = node.text();
	if (!isQuoted(text)) return undefined;
	if (node.kind() === "string")
		return cookedString(text) ?? cookedString(lenient(text));
	if (
		node.kind() === "template_string" &&
		!named(node).some((child) => child.kind() === "template_substitution")
	)
		return cookedString(text) ?? cookedString(lenient(text));
	return undefined;
}

/** A member access: `a.b`, or `a[k]` (whose name is static only for a literal `k`). */
function isMember(node: SgNode): boolean {
	const kind = node.kind();
	return kind === "member_expression" || kind === "subscript_expression";
}

/**
 * The static name a member access reads: `a.b`, and `a["b"]` with a literal
 * key (review r5 LOW: `path["resolve"](p)` and `m["set"](…)` read the same
 * member as the dotted spelling). A computed key has none.
 */
function memberName(member: SgNode): string | undefined {
	if (member.kind() === "subscript_expression") {
		const index = member.field("index");
		return index ? literalValue(unwrap(index)) : undefined;
	}
	const property = member.field("property");
	return property ? cookedIdentifier(property.text()) : undefined;
}

function argumentsOf(call: SgNode): SgNode[] {
	const args = call.field("arguments");
	return args ? named(args) : [];
}

/**
 * A literal's text with the escapes `cookedString` refuses rewritten to the
 * character they hold in sloppy-mode JavaScript: a legacy octal escape, and an
 * unknown escape (`\.` is `.`). A tagged template such as `String.raw` keeps
 * its raw text at runtime, which this reading covers too: a raw backslash
 * cannot spell a letter.
 */
function lenient(text: string): string {
	return text.replace(
		/\\([0-7]{1,3}|[^xu0-7\n\r])/g,
		(whole, escape: string) => {
			if (/^[0-7]+$/.test(escape)) {
				const hex = Number.parseInt(escape, 8).toString(16).padStart(2, "0");
				return hex.length === 2 ? `\\x${hex}` : whole;
			}
			return whole.length === 2 && "bfnrtv'\"`\\".includes(escape)
				? whole
				: escape;
		},
	);
}

function isQuoted(text: string): boolean {
	return text.startsWith('"') || text.startsWith("'") || text.startsWith("`");
}

function realpathSites(root: SgNode): PathIdentitySite[] {
	const sites: PathIdentitySite[] = [];
	for (const node of root.findAll({
		rule: { any: [...NAME_KINDS].map((kind) => ({ kind })) },
	})) {
		if (REALPATH_NAMES.has(cookedIdentifier(node.text())))
			sites.push({
				needle: "raw-realpath",
				line: node.range().start.line,
				form: `name ${node.kind()}`,
			});
	}
	for (const node of root.findAll({
		rule: { any: [{ kind: "string" }, { kind: "template_string" }] },
	})) {
		const text = node.text();
		if (!isQuoted(text)) continue;
		// A template with a substitution has no single cooked value; its pieces
		// are the concatenation residual the sweep header names.
		if (
			node.kind() === "template_string" &&
			named(node).some((child) => child.kind() === "template_substitution")
		)
			continue;
		const cooked = cookedString(text) ?? cookedString(lenient(text));
		if (cooked === undefined)
			sites.push({
				needle: "raw-realpath",
				line: node.range().start.line,
				form: "uncookable string",
			});
		else if (REALPATH_NAMES.has(cooked))
			sites.push({
				needle: "raw-realpath",
				line: node.range().start.line,
				form: "string value",
			});
	}
	return sites;
}

interface ResolveBindings {
	/** Local names that ARE resolve: `import { resolve as r }`, `const r = path.resolve`. */
	callees: Set<string>;
}

function isResolveCallee(node: SgNode, bindings: ResolveBindings): boolean {
	const value = unwrap(node);
	if (isMember(value)) return memberName(value) === "resolve";
	if (value.kind() === "identifier") {
		const name = cookedIdentifier(value.text());
		return name === "resolve" || bindings.callees.has(name);
	}
	return false;
}

function isResolveCall(node: SgNode, bindings: ResolveBindings): boolean {
	const value = unwrap(node);
	if (value.kind() !== "call_expression") return false;
	const callee = value.field("function");
	return callee !== null && isResolveCallee(callee, bindings);
}

function isResolveValue(node: SgNode, bindings: ResolveBindings): boolean {
	const value = unwrap(node);
	if (isResolveCall(value, bindings)) return true;
	if (value.kind() === "identifier" && boundToResolveCall(value, bindings))
		return true;
	// An uncalled resolve: `xs.map(path.resolve)` keys by its result.
	return isResolveCallee(value, bindings);
}

/** Scopes that own declarations, nearest first as a use walks outward. */
const SCOPE_KINDS: ReadonlySet<string> = new Set([
	"program",
	"statement_block",
	"switch_case",
	"switch_default",
	"for_statement",
	"for_in_statement",
	"catch_clause",
	"arrow_function",
	"function_declaration",
	"function_expression",
	"generator_function_declaration",
	"generator_function",
	"method_definition",
]);

/** The names a binding pattern introduces (default values excluded). */
function patternNames(pattern: SgNode): string[] {
	switch (pattern.kind()) {
		case "identifier":
		case "shorthand_property_identifier_pattern":
			return [cookedIdentifier(pattern.text())];
		case "assignment_pattern":
		case "object_assignment_pattern": {
			const left = pattern.field("left") ?? named(pattern)[0];
			return left ? patternNames(left) : [];
		}
		case "pair_pattern": {
			const value = pattern.field("value");
			return value ? patternNames(value) : [];
		}
		case "required_parameter":
		case "optional_parameter": {
			const inner = pattern.field("pattern") ?? named(pattern)[0];
			return inner ? patternNames(inner) : [];
		}
		default:
			return named(pattern).flatMap(patternNames);
	}
}

type Declared = "resolve-call" | "other" | undefined;

function declaratorsOf(declaration: SgNode): SgNode[] {
	return named(declaration).filter(
		(child) => child.kind() === "variable_declarator",
	);
}

function fromDeclarators(
	declarators: SgNode[],
	name: string,
	bindings: ResolveBindings,
): Declared {
	for (const declarator of declarators) {
		const pattern = declarator.field("name");
		if (!pattern || !patternNames(pattern).includes(name)) continue;
		const value = declarator.field("value");
		return pattern.kind() === "identifier" &&
			value &&
			isResolveCall(value, bindings)
			? "resolve-call"
			: "other";
	}
	return undefined;
}

/** What `scope` itself declares `name` as, or `undefined` when it does not. */
function declaredIn(
	scope: SgNode,
	name: string,
	bindings: ResolveBindings,
): Declared {
	switch (scope.kind()) {
		case "program":
		case "statement_block":
		case "switch_case":
		case "switch_default":
			for (const child of named(scope)) {
				const statement =
					child.kind() === "export_statement"
						? (named(child)[0] ?? child)
						: child;
				const kind = statement.kind();
				if (kind === "lexical_declaration" || kind === "variable_declaration") {
					const found = fromDeclarators(
						declaratorsOf(statement),
						name,
						bindings,
					);
					if (found) return found;
				} else if (
					(kind === "function_declaration" ||
						kind === "class_declaration" ||
						kind === "generator_function_declaration") &&
					statement.field("name")?.text() === name
				)
					return "other";
			}
			return undefined;
		case "for_statement": {
			const init = scope.field("initializer");
			return init
				? fromDeclarators(declaratorsOf(init), name, bindings)
				: undefined;
		}
		case "for_in_statement": {
			const left = scope.field("left");
			return left && patternNames(left).includes(name) ? "other" : undefined;
		}
		case "catch_clause": {
			const parameter = scope.field("parameter");
			return parameter && patternNames(parameter).includes(name)
				? "other"
				: undefined;
		}
		default: {
			const parameters = scope.field("parameters") ?? scope.field("parameter");
			return parameters && patternNames(parameters).includes(name)
				? "other"
				: undefined;
		}
	}
}

/** True when the nearest declaration of `use` binds it to a resolve call. */
function boundToResolveCall(use: SgNode, bindings: ResolveBindings): boolean {
	const name = cookedIdentifier(use.text());
	for (let scope = use.parent(); scope; scope = scope.parent()) {
		if (!SCOPE_KINDS.has(String(scope.kind()))) continue;
		const declared = declaredIn(scope, name, bindings);
		if (declared) return declared === "resolve-call";
	}
	return false;
}

function resolveBindings(root: SgNode): ResolveBindings {
	const bindings: ResolveBindings = { callees: new Set() };
	for (const specifier of root.findAll({
		rule: { kind: "import_specifier" },
	})) {
		const parts = named(specifier);
		const imported = parts[0];
		const local = parts[1] ?? parts[0];
		if (imported && local && cookedIdentifier(imported.text()) === "resolve")
			bindings.callees.add(cookedIdentifier(local.text()));
	}
	for (const pair of root.findAll({ rule: { kind: "pair_pattern" } })) {
		const key = pair.field("key");
		const value = pair.field("value");
		if (
			key &&
			value &&
			cookedIdentifier(key.text()) === "resolve" &&
			value.kind() === "identifier"
		)
			bindings.callees.add(cookedIdentifier(value.text()));
	}
	for (const declarator of root.findAll({
		rule: { kind: "variable_declarator" },
	})) {
		const name = declarator.field("name");
		const value = declarator.field("value");
		if (!name || !value || name.kind() !== "identifier") continue;
		const held = unwrap(value);
		if (isMember(held) && memberName(held) === "resolve")
			bindings.callees.add(cookedIdentifier(name.text()));
	}
	return bindings;
}

/** Key values inside `new Map/Set(…)`'s arguments, through the shapes that carry them. */
function collectionKeyValues(node: SgNode, out: SgNode[]): void {
	const value = unwrap(node);
	switch (value.kind()) {
		case "array":
			for (const element of named(value)) collectionKeyValues(element, out);
			return;
		case "spread_element":
			for (const inner of named(value)) collectionKeyValues(inner, out);
			return;
		case "arrow_function": {
			const body = value.field("body");
			if (!body) return;
			if (body.kind() === "statement_block") {
				for (const ret of body.findAll({ rule: { kind: "return_statement" } }))
					for (const inner of named(ret)) collectionKeyValues(inner, out);
			} else collectionKeyValues(body, out);
			return;
		}
		case "call_expression": {
			const callee = value.field("function");
			const method =
				callee && isMember(callee) ? memberName(callee) : undefined;
			if (method === "map" || method === "flatMap") {
				for (const arg of argumentsOf(value)) collectionKeyValues(arg, out);
				return;
			}
			if (method === "from" && callee?.field("object")?.text() === "Array") {
				for (const arg of argumentsOf(value)) collectionKeyValues(arg, out);
				return;
			}
			out.push(value);
			return;
		}
		default:
			out.push(value);
	}
}

function resolveKeyedSites(root: SgNode): PathIdentitySite[] {
	const bindings = resolveBindings(root);
	const sites: PathIdentitySite[] = [];
	const site = (node: SgNode, form: string): void => {
		sites.push({
			needle: "path-resolve-keyed",
			line: node.range().start.line,
			form,
		});
	};
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee || !isMember(callee)) continue;
		const method = memberName(callee);
		const args = argumentsOf(call);
		if (method && KEY_METHODS.has(method)) {
			const key = args[0];
			if (key && isResolveValue(key, bindings)) site(key, `.${method} key`);
			continue;
		}
		const target = callee.field("object");
		if (method === "call" && target && isMember(target)) {
			const inner = memberName(target);
			const key = args[1];
			if (
				inner &&
				KEY_METHODS.has(inner) &&
				key &&
				isResolveValue(key, bindings)
			)
				site(key, `.${inner}.call key`);
		}
	}
	for (const subscript of root.findAll({
		rule: { kind: "subscript_expression" },
	})) {
		const index = subscript.field("index");
		if (index && isResolveValue(index, bindings))
			site(index, "subscript index");
	}
	for (const created of root.findAll({ rule: { kind: "new_expression" } })) {
		const constructor = created.field("constructor");
		if (
			!constructor ||
			!KEYED_COLLECTIONS.has(cookedIdentifier(constructor.text()))
		)
			continue;
		const values: SgNode[] = [];
		for (const arg of argumentsOf(created)) collectionKeyValues(arg, values);
		for (const value of values)
			if (isResolveValue(value, bindings))
				site(value, `new ${constructor.text()} element`);
	}
	return sites;
}

/** Every path identity site in one TypeScript source, in source order. */
export function scanPathIdentitySites(source: string): PathIdentitySite[] {
	const root = parse(Lang.TypeScript, source).root();
	return [...realpathSites(root), ...resolveKeyedSites(root)].sort(
		(a, b) => a.line - b.line || a.needle.localeCompare(b.needle),
	);
}
