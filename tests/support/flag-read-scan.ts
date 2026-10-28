/**
 * Detector for a flag read whose name the registry never registers (#4946).
 *
 * Recurrence this prevents (#4944, #4946): `pi.getFlag("no-ast-grep")` and
 * `killSwitchFlag: "no-typos"` were read for months while no
 * `clients/lens-flag-registry.ts` entry registered the name, so the host
 * answered `undefined` and the feature behind it could not be switched. The
 * call compiles and runs, so only a cross-file check against the registry can
 * see it.
 *
 * Population: the TypeScript files the caller hands in (`clients/`, `tools/`,
 * `mcp/`, `index.ts`). Input: the raw source, parsed by the census AST seam
 * (`ast-census.ts`). No regex reads source text: a comment is a `comment` node
 * and a string (a template's fixed parts included) is a `string` node, so
 * neither can hold a call or a `killSwitchFlag:` pair (a template's `${..}`
 * substitution is code and is scanned), and a comment that quotes
 * `getFlag("x")` is no read (AGENTS.md "Detectors match code, not
 * prose"; the self-test below plants both spellings). The flag name IS a string
 * literal, so the only string the scan reads is the first argument of a call it
 * found as code.
 *
 * Registered names (the closed set): every `LENS_FLAGS` name the caller passes,
 * plus every literal first argument of a `registerFlag(...)` call in the scanned
 * files (`index.ts` registers `no-tool` outside the registry).
 *
 * ADMITTED forms; every other form is REFUSED and reported with file and line:
 *
 * - R1: a call to a reader whose first argument is a string literal naming a
 *   registered flag.
 * - R2: `killSwitchFlag: "<literal>"` (the auxiliary-LSP profile field that
 *   `isEnabledByConfiguration` hands to `getFlag`) naming a registered flag.
 * - R3: a call to a reader whose first argument is a parameter of the enclosing
 *   function (a forwarder). A forwarder bound to a bare name (`const f = (p) =>
 *   getFlag(p)`, `function f(p)`) makes `f` a reader too, so its callers are
 *   scanned (derived, to a fixpoint).
 * - R4: a reader named as a call argument, a declaration or parameter name, a
 *   shorthand property, a `pair` key, the value of a `pair` under the same key,
 *   the left side of an assignment, an operand of a comparison, logical or
 *   `!`, the condition of an `if` or ternary, or the operand of a type query.
 * - R5: a {@link FlagReadAdmission} row keyed `file:form`, with a reason and a
 *   site count; a key with more live sites reports every one, one with fewer is
 *   stale.
 *
 * A reader is a callee whose final identifier matches {@link READER_NAME}.
 *
 * RESIDUALS, named (each an admitted form that is too broad): R4's "passed as a
 * call argument" lets the receiving function name its parameter anything and
 * call it with a literal; R3's anonymous forwarder (`(f) => getFlag(f)` handed
 * to a callee) leaves the names to that callee.
 */
import type { SgNode } from "@ast-grep/napi";
import { parseNodes } from "./ast-census.js";
import { lineOf } from "./sweep-kit.js";

/** The callee names that read a flag: `getFlag`, `getLensFlag`, `getFlagSource`, ... */
const READER_NAME = /^get\w*Flag\w*$/;

/** A refused site the tree admits under one key: how many, and why none is a defect. */
export type FlagReadAdmission = Readonly<
	Record<string, { readonly count: number; readonly reason: string }>
>;

export interface FlagReadSite {
	readonly file: string;
	readonly line: number;
	/** `file:form`, the admission key. */
	readonly key: string;
	/** What was refused, for the report. */
	readonly detail: string;
}

export interface FlagReadScan {
	/** Every flag name read as a registered literal (R1, R2). */
	readonly literalReads: readonly {
		file: string;
		line: number;
		name: string;
	}[];
	/** The registered names the scan used (registry plus `registerFlag` literals). */
	readonly registered: ReadonlySet<string>;
	/** Refused sites, admitted or not. */
	readonly sites: readonly FlagReadSite[];
	/** Sites no admission covers, or every site of a key with more sites than its row admits. */
	readonly unadmitted: readonly FlagReadSite[];
	/** Admission keys with fewer sites than the row admits. */
	readonly staleAdmissions: readonly string[];
}

const kindOf = (node: SgNode): string => String(node.kind());

const TRANSPARENT = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
]);

const FUNCTIONS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"function",
	"method_definition",
	"generator_function",
	"generator_function_declaration",
]);

/** The value of a string literal node, or undefined for anything else (template substitutions included). */
function literalValue(node: SgNode): string | undefined {
	const text = node.text();
	if (kindOf(node) === "string") return text.slice(1, -1);
	if (kindOf(node) === "template_string" && !text.includes("${"))
		return text.slice(1, -1);
	return undefined;
}

const unwrap = (node: SgNode): SgNode => {
	let current = node;
	while (TRANSPARENT.has(kindOf(current))) {
		const inner = current.children().find((c) => c.isNamed());
		if (!inner) break;
		current = inner;
	}
	return current;
};

/** The final identifier a callee names, and whether it is a computed (string-keyed) access. */
function calleeName(callee: SgNode): { name?: string; computed: boolean } {
	const node = unwrap(callee);
	const kind = kindOf(node);
	if (kind === "identifier") return { name: node.text(), computed: false };
	if (kind === "member_expression")
		return { name: node.field("property")?.text(), computed: false };
	if (kind === "subscript_expression") {
		const index = node.field("index");
		const value = index ? literalValue(index) : undefined;
		return { name: value, computed: true };
	}
	return { computed: false };
}

/** The reference expression `node` is part of, climbing `a.<node>` and wrappers. */
function referenceOf(node: SgNode): SgNode {
	let current = node;
	for (;;) {
		const parent = current.parent();
		if (!parent) return current;
		if (
			TRANSPARENT.has(kindOf(parent)) ||
			(kindOf(parent) === "member_expression" &&
				parent.field("property")?.range().start.index ===
					current.range().start.index &&
				parent.field("property")?.range().end.index ===
					current.range().end.index)
		)
			current = parent;
		else return current;
	}
}

const sameNode = (a: SgNode | null | undefined, b: SgNode): boolean =>
	a !== null &&
	a !== undefined &&
	a.range().start.index === b.range().start.index &&
	a.range().end.index === b.range().end.index;

/** Why a reader reference is refused, or undefined when an admitted context holds it (R4). */
function refusedContext(identifier: SgNode): string | undefined {
	const ref = referenceOf(identifier);
	const parent = ref.parent();
	if (!parent) return undefined;
	const kind = kindOf(parent);
	// The callee of a call is checked at the call; an argument is R4.
	if (kind === "call_expression" || kind === "arguments") return undefined;
	if (kind === "pair")
		return sameNode(parent.field("key"), ref) ||
			parent.field("key")?.text() === identifier.text()
			? undefined
			: `pair value under another key \`${parent.field("key")?.text()}\``;
	if (kind === "assignment_expression")
		return sameNode(parent.field("left"), ref)
			? undefined
			: "right-hand side of an assignment";
	if (kind === "binary_expression" || kind === "unary_expression")
		return undefined;
	if (kind === "ternary_expression")
		return sameNode(parent.field("condition"), ref)
			? undefined
			: "ternary branch";
	// `typeof getFlag` in a type position names the type; nothing can call it.
	if (kind === "if_statement" || kind === "type_query") return undefined;
	if (kind === "import_specifier" || kind === "export_specifier")
		return parent.field("alias")
			? `aliased by \`${parent.field("alias")?.text()}\``
			: undefined;
	// A declaration or parameter name keeps the name.
	if (
		["name", "pattern"].some((field) => sameNode(parent.field(field), ref)) &&
		kind !== "pair_pattern"
	)
		return undefined;
	if (
		kind === "shorthand_property_identifier" ||
		kind === "shorthand_property_identifier_pattern"
	)
		return undefined;
	if (kind === "member_expression")
		return `object of \`.${parent.field("property")?.text()}\``;
	if (kind === "variable_declarator") return "right-hand side of a binding";
	return `form \`${kind}\``;
}

/** The innermost enclosing function node. */
function enclosingFunction(node: SgNode): SgNode | undefined {
	for (let at = node.parent(); at; at = at.parent())
		if (FUNCTIONS.has(kindOf(at))) return at;
	return undefined;
}

function parameterNames(fn: SgNode): Set<string> {
	const names = new Set<string>();
	const single = fn.field("parameter");
	if (single) names.add(single.text());
	for (const param of fn.field("parameters")?.children() ?? []) {
		if (!param.isNamed()) continue;
		const pattern = param.field("pattern") ?? param;
		if (kindOf(pattern) === "identifier") names.add(pattern.text());
	}
	return names;
}

/** The bare name a function is bound to (`const f = ..`, `function f`), the only names a forwarder lends the reader set. */
function boundName(fn: SgNode): string | undefined {
	if (kindOf(fn) === "function_declaration") return fn.field("name")?.text();
	const parent = fn.parent();
	return parent && kindOf(parent) === "variable_declarator"
		? parent.field("name")?.text()
		: undefined;
}

/**
 * Scan source texts. `files` maps a repo-relative path to its raw source;
 * `registeredByRegistry` is the registry's names; `admitted` is the R5 table.
 */
export function scanFlagReads(
	files: Readonly<Record<string, string>>,
	registeredByRegistry: Iterable<string>,
	admitted: FlagReadAdmission = {},
): FlagReadScan {
	const parsed = Object.entries(files).map(([file, raw]) => {
		return { file, text: raw, nodes: parseNodes(raw) };
	});
	const registered = new Set(registeredByRegistry);
	for (const { nodes } of parsed)
		for (const node of nodes) {
			if (kindOf(node) !== "call_expression") continue;
			const { name } = calleeName(node.field("function") as SgNode);
			if (name !== "registerFlag") continue;
			const first = node
				.field("arguments")
				?.children()
				.find((c) => c.isNamed());
			const value = first ? literalValue(first) : undefined;
			if (value !== undefined) registered.add(value);
		}

	const readers = new Set<string>();
	const isReader = (name: string | undefined): boolean =>
		name !== undefined && (READER_NAME.test(name) || readers.has(name));

	// R3 fixpoint: a forwarder bound to a bare name is a reader too.
	for (let grew = true; grew;) {
		grew = false;
		for (const { nodes } of parsed)
			for (const node of nodes) {
				if (kindOf(node) !== "call_expression") continue;
				const { name } = calleeName(node.field("function") as SgNode);
				if (!isReader(name)) continue;
				const first = node
					.field("arguments")
					?.children()
					.find((c) => c.isNamed());
				const fn = enclosingFunction(node);
				if (!first || !fn || kindOf(first) !== "identifier") continue;
				if (!parameterNames(fn).has(first.text())) continue;
				const bound = boundName(fn);
				if (bound !== undefined && !readers.has(bound)) {
					readers.add(bound);
					grew = true;
				}
			}
	}

	const literalReads: FlagReadScan["literalReads"][number][] = [];
	const sites: FlagReadSite[] = [];
	const refuse = (file: string, text: string, node: SgNode, form: string) =>
		sites.push({
			file,
			line: lineOf(text, node.range().start.index),
			key: `${file}:${form}`,
			detail: form,
		});
	const checkLiteral = (
		file: string,
		text: string,
		node: SgNode,
		value: string,
		form: string,
	) => {
		if (registered.has(value))
			literalReads.push({
				file,
				line: lineOf(text, node.range().start.index),
				name: value,
			});
		else refuse(file, text, node, `unregistered ${form} \`${value}\``);
	};

	for (const { file, text, nodes } of parsed)
		for (const node of nodes) {
			const kind = kindOf(node);
			if (kind === "call_expression") {
				const callee = node.field("function") as SgNode;
				const { name, computed } = calleeName(callee);
				if (!isReader(name)) continue;
				if (computed) {
					refuse(file, text, node, `computed reader \`[${name}]\``);
					continue;
				}
				const first = node
					.field("arguments")
					?.children()
					.find((c) => c.isNamed());
				if (!first) {
					refuse(file, text, node, `${name}() with no flag name`);
					continue;
				}
				const value = literalValue(first);
				if (value !== undefined) {
					checkLiteral(file, text, first, value, `${name}(...)`);
					continue;
				}
				const fn = enclosingFunction(node);
				if (
					kindOf(first) === "identifier" &&
					fn !== undefined &&
					parameterNames(fn).has(first.text())
				)
					continue; // R3: a forwarder
				refuse(file, text, node, `${callee.text()}(${first.text()})`);
			} else if (
				(kind === "identifier" || kind === "property_identifier") &&
				isReader(node.text())
			) {
				const why = refusedContext(node);
				if (why !== undefined)
					refuse(file, text, node, `${node.text()} as ${why}`);
			} else if (kind === "subscript_expression") {
				const index = node.field("index");
				const value = index ? literalValue(index) : undefined;
				if (isReader(value) && sameNode(referenceOf(node), node)) {
					const parent = node.parent();
					if (!parent || kindOf(parent) !== "call_expression")
						refuse(file, text, node, `computed reader \`[${value}]\``);
				}
			} else if (kind === "pair") {
				if (node.field("key")?.text() !== "killSwitchFlag") continue;
				const value = node.field("value");
				const literal = value ? literalValue(value) : undefined;
				if (literal === undefined)
					refuse(file, text, node, "killSwitchFlag without a literal name");
				else
					checkLiteral(file, text, value as SgNode, literal, "killSwitchFlag");
			}
		}

	const counts = new Map<string, number>();
	for (const site of sites)
		counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
	const unadmitted = sites.filter((site) => {
		const row = admitted[site.key];
		return row === undefined || (counts.get(site.key) ?? 0) > row.count;
	});
	const staleAdmissions = Object.entries(admitted)
		.filter(([key, row]) => (counts.get(key) ?? 0) < row.count)
		.map(([key]) => key);
	return { literalReads, registered, sites, unadmitted, staleAdmissions };
}
