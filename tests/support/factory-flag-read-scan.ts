/**
 * Detector for a flag read that runs while an extension factory runs (#4913).
 *
 * Recurrence this prevents (AGENTS.md shape 87, "factory-time read of a host
 * value pi sets after the factory"): pi applies the command-line values of an
 * extension's flags after every factory has run, so `pi.getFlag` inside the
 * factory answers the registered default. `index.ts` read `no-lens`,
 * `no-lens-context`, `lens-compact-tool-line` and `--no-tool` there, and
 * `pi --no-lens` still started language servers.
 *
 * Population: the function pi calls as the factory, which is the default
 * export's own function node (inline, or the module-level function that
 * `export default f` / `export { f as default }` names), AND, transitively,
 * every module-level function or function-valued constant those bodies call
 * while they run (a helper the factory calls synchronously is part of the
 * factory; today the chain reaches `activateExtension`). A default export the
 * scan cannot resolve to one such function throws instead of passing. The
 * module top level is not in it: it runs at import, before pi hands the
 * factory its API. It is parsed
 * from COMMENT-AND-STRING-BLANKED text (`stripSource`, so a comment that
 * quotes `getLensFlag(` is not a read), through the census AST seam
 * (`ast-census.ts`).
 *
 * The reader set R is the base names {@link BASE_READERS} plus, by fixpoint,
 * every function-valued binding or declaration in the population whose text
 * references a member of R. An indirect read (`const read = () =>
 * getLensFlag(..); read()`) is therefore a read at the call to `read`.
 *
 * FAIL CLOSED (the round-2 redesign, #4917 F2). A function is factory-time
 * code unless it is one of the short list of forms that only DEFERS it:
 *
 * - a function declaration, or a function bound by `const f = () => ..`: it
 *   runs when called, and a call at factory time is itself a reference to a
 *   reader (the fixpoint above) or a transitively scanned helper;
 * - a function (or an object literal holding functions) passed as an argument
 *   of a call to a known deferring registrar, directly or through wrapper
 *   calls whose result is the registrar's argument (`pi.on("x", wrap(fn))`): `pi.on`, `registerCommand`,
 *   `registerTool`, the other `register*` hooks, event `on`/`once`, timers,
 *   `queueMicrotask`, and the promise continuations `then`/`catch`/`finally`.
 *
 * Every other function is refused: an IIFE (arrow or `function`), an object
 * method or property the factory invokes, a `new Promise` executor, a
 * synchronous array callback, and anything nobody planned for. A reference to
 * a member of R inside such a function is a factory-time read.
 *
 * A reference to a member of R at factory time is then classified by where it
 * sits. The detector ADMITS a short list of forms and REFUSES every other:
 *
 * - a declaration name, or an object-literal key: not a use, admitted;
 * - an argument of a call, or the value of a pair in an object literal that is
 *   itself a call argument: the reader is handed to a callee that stores it,
 *   admitted. RESIDUAL, named: a callee that invokes its argument
 *   synchronously reads at factory time, and this scan cannot see into it;
 * - anything else, which includes a call to a reader, an alias binding, an
 *   assignment right-hand side, an array element, `.call`/`.apply`/`.bind` on
 *   a reader, and a destructuring: REFUSED, unless an
 *   {@link FactoryFlagAdmission} row keyed `<function>:<binding>:<reader>:<form>` carries its
 *   reason.
 *
 * RESIDUALS, named. The call graph follows direct calls by name only: a helper
 * reached through a variable, a method, a dynamic `import()` or a callback the
 * factory hands to a callee that runs it synchronously is invisible. A
 * registrar name in the allowlist that a given object runs synchronously
 * (an `on` of an emitter that fires at once) is trusted. A flag read in a
 * module the factory imports is not scanned.
 */
import type { SgNode } from "@ast-grep/napi";
import { parseNodes } from "./ast-census.js";
import { stripSource } from "./sweep-kit.js";

/** Names whose call reads a flag value: the closure and the host member. */
export const BASE_READERS: readonly string[] = [
	"getLensFlag",
	"getLensFlagSource",
	"noToolFlag",
	"getFlag",
];

/** A refused site the tree admits, with the reason it is not a defect. */
export type FactoryFlagAdmission = Readonly<Record<string, string>>;

export interface FactoryFlagRead {
	readonly line: number;
	readonly reader: string;
	/** The enclosing declarator's name, or `<top>`. */
	readonly binding: string;
	/** `function:binding:reader:form`, the admission key. */
	readonly key: string;
	/** How the reader appears: `call`, or the kind of the node holding it. */
	readonly form: string;
}

export interface FactoryFlagScan {
	/** Names of the functions whose bodies were scanned. */
	readonly population: readonly string[];
	/** Every refused site, admitted or not. */
	readonly sites: readonly FactoryFlagRead[];
	/** The sites no admission row covers. */
	readonly unadmitted: readonly FactoryFlagRead[];
	/** Admission keys no site used (a stale row). */
	readonly staleAdmissions: readonly string[];
}

const FUNCTION_KINDS = new Set([
	"arrow_function",
	"function_declaration",
	"function_expression",
	"function",
	"method_definition",
	"generator_function",
	"generator_function_declaration",
]);

/** Callee identifiers that defer the function they are handed. */
const DEFERRING_FUNCTIONS = new Set([
	"setTimeout",
	"setInterval",
	"setImmediate",
	"queueMicrotask",
]);

/** Member names that defer the function they are handed: host registrars. */
const DEFERRING_METHODS = new Set([
	"on",
	"once",
	"addListener",
	"addEventListener",
	"registerCommand",
	"registerTool",
	"registerFlag",
	"registerShortcut",
	"registerMessageRenderer",
	"registerProvider",
	"then",
	"catch",
	"finally",
]);

/** Expression wrappers that do not change what a function is passed to. */
const WRAPPER_KINDS = new Set([
	"parenthesized_expression",
	"as_expression",
	"satisfies_expression",
	"non_null_expression",
]);

const kindOf = (node: SgNode): string => String(node.kind());

const sameNode = (a: SgNode, b: SgNode): boolean =>
	a.range().start.index === b.range().start.index &&
	a.range().end.index === b.range().end.index &&
	kindOf(a) === kindOf(b);

/**
 * The nodes of a document-ordered array that start inside `outer`. The array
 * is a pre-order walk, so starts never decrease and one binary search plus a
 * forward run answers it; a rescan of the whole array per function was
 * quadratic over `index.ts` (about 100k nodes) and timed out.
 */
function within(nodes: readonly SgNode[], outer: SgNode): SgNode[] {
	const { start, end } = {
		start: outer.range().start.index,
		end: outer.range().end.index,
	};
	let low = 0;
	let high = nodes.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((nodes[mid] as SgNode).range().start.index < start) low = mid + 1;
		else high = mid;
	}
	const found: SgNode[] = [];
	for (
		let i = low;
		i < nodes.length && (nodes[i] as SgNode).range().start.index < end;
		i++
	)
		found.push(nodes[i] as SgNode);
	return found;
}

const NAME_KINDS = new Set(["identifier", "property_identifier"]);

/** The identifier names a node's subtree mentions. */
function namesWithin(nodes: readonly SgNode[], outer: SgNode): Set<string> {
	return new Set(
		within(nodes, outer)
			.filter((node) => NAME_KINDS.has(kindOf(node)))
			.map((node) => node.text()),
	);
}

/** The identifier a declaration or declarator binds, if it has one. */
function boundName(node: SgNode): string | undefined {
	return node.field("name")?.text();
}

/** True when `child` is the node `parent` holds in field `name`. */
function isField(parent: SgNode, name: string, child: SgNode): boolean {
	const held = parent.field(name);
	return held !== null && sameNode(held, child);
}

function isFunctionValuedBinding(node: SgNode): boolean {
	if (kindOf(node) === "function_declaration") return true;
	if (kindOf(node) !== "variable_declarator") return false;
	const value = node.field("value");
	return value !== null && FUNCTION_KINDS.has(kindOf(value));
}

/** The function a module-level declaration or constant defines, if any. */
function moduleFunctionOf(node: SgNode): { name: string; fn: SgNode } | null {
	const parent = node.parent();
	if (!parent) return null;
	const atModule = (n: SgNode | null): boolean => {
		if (!n) return false;
		const holder = kindOf(n) === "export_statement" ? n.parent() : n;
		return holder !== null && kindOf(holder) === "program";
	};
	if (kindOf(node) === "function_declaration") {
		if (!atModule(parent)) return null;
		const name = boundName(node);
		return name ? { name, fn: node } : null;
	}
	if (kindOf(node) === "variable_declarator") {
		const declaration = parent;
		if (
			kindOf(declaration) !== "lexical_declaration" ||
			!atModule(declaration.parent())
		)
			return null;
		const value = node.field("value");
		const name = boundName(node);
		return value && name && FUNCTION_KINDS.has(kindOf(value))
			? { name, fn: value }
			: null;
	}
	return null;
}

/** A population function's reporting name; `<default>` for an inline default export. */
function nameOf(fn: SgNode): string {
	if (kindOf(fn) === "function_declaration")
		return boundName(fn) ?? "<anonymous>";
	let holder = fn.parent();
	while (holder && WRAPPER_KINDS.has(kindOf(holder))) holder = holder.parent();
	if (holder && kindOf(holder) === "export_statement") return "<default>";
	return holder && kindOf(holder) === "variable_declarator"
		? (boundName(holder) ?? "<anonymous>")
		: "<anonymous>";
}

/** The node a module's default export names: its value, declaration or local name. */
function defaultExportValue(nodes: SgNode[]): SgNode {
	for (const statement of nodes) {
		if (kindOf(statement) !== "export_statement") continue;
		// `export default` always holds a declaration or a value.
		if (statement.children().some((child) => kindOf(child) === "default"))
			return (statement.field("declaration") ??
				statement.field("value")) as SgNode;
		const specifier = within(nodes, statement).find(
			(node) =>
				kindOf(node) === "export_specifier" &&
				(node.field("alias") ?? node.field("name"))?.text() === "default",
		);
		const local = specifier?.field("name");
		if (!local) continue;
		if (statement.field("source"))
			throw new Error(
				"factory-flag scan: the default export is re-exported from another module",
			);
		return local;
	}
	throw new Error("factory-flag scan: no default export found");
}

/**
 * The function pi calls as the factory: the default export's own node. An
 * inline function (through expression wrappers) is that node; a name
 * (`export default f`, `export { f as default }`) resolves to the module-level
 * function `f`. Anything else (a call, a class, a re-export, a name this module
 * does not define as a function) throws: the scan cannot say what runs, so it
 * does not pass (#4917 F6).
 */
function factoryFunction(
	nodes: SgNode[],
	moduleFunctions: ReadonlyMap<string, SgNode>,
): SgNode {
	let exported = defaultExportValue(nodes);
	// Each wrapper kind holds the expression it wraps as its first named child.
	while (WRAPPER_KINDS.has(kindOf(exported)))
		exported = exported.children().find((child) => child.isNamed()) as SgNode;
	if (FUNCTION_KINDS.has(kindOf(exported))) return exported;
	const named =
		kindOf(exported) === "identifier"
			? moduleFunctions.get(exported.text())
			: undefined;
	if (!named)
		throw new Error(
			`factory-flag scan: the default export \`${exported.text()}\` is not a function this module defines`,
		);
	return named;
}

/**
 * The functions that run while the factory runs: the default export's own
 * function, then, transitively, every module-level function those bodies call
 * by name at factory time (a call inside a function that only defers its body
 * is not one).
 */
function populationFunctions(nodes: SgNode[]): SgNode[] {
	const moduleFunctions = new Map<string, SgNode>();
	for (const node of nodes) {
		const found = moduleFunctionOf(node);
		if (found && !moduleFunctions.has(found.name))
			moduleFunctions.set(found.name, found.fn);
	}
	const population: SgNode[] = [];
	const queue = [factoryFunction(nodes, moduleFunctions)];
	const seen = new Set<number>();
	while (queue.length > 0) {
		const fn = queue.shift() as SgNode;
		const start = fn.range().start.index;
		if (seen.has(start)) continue;
		seen.add(start);
		population.push(fn);
		for (const node of within(nodes, fn)) {
			if (kindOf(node) !== "call_expression" || !runsWithin(node, fn)) continue;
			const callee = node.field("function");
			const helper =
				callee && kindOf(callee) === "identifier"
					? moduleFunctions.get(callee.text())
					: undefined;
			if (helper) queue.push(helper);
		}
	}
	return population;
}

/** The reader names: base plus every function whose text references one. */
function readerSet(population: SgNode[], nodes: SgNode[]): Set<string> {
	const readers = new Set(BASE_READERS);
	const candidates = population.flatMap((fn) =>
		within(nodes, fn).filter(
			(node) => isFunctionValuedBinding(node) && !sameNode(fn, node),
		),
	);
	const mentions = candidates.map((candidate) => ({
		name: boundName(candidate),
		names: namesWithin(nodes, candidate),
	}));
	let grew = true;
	while (grew) {
		grew = false;
		for (const { name, names } of mentions) {
			if (!name || readers.has(name)) continue;
			const references = [...names].some(
				(mentioned) => mentioned !== name && readers.has(mentioned),
			);
			if (references) {
				readers.add(name);
				grew = true;
			}
		}
	}
	return readers;
}

/** True when `callee` is a known deferring registrar. */
function isDeferringCallee(callee: SgNode | null): boolean {
	if (!callee) return false;
	if (kindOf(callee) === "identifier")
		return DEFERRING_FUNCTIONS.has(callee.text());
	if (kindOf(callee) !== "member_expression") return false;
	const property = callee.field("property")?.text() ?? "";
	return DEFERRING_METHODS.has(property);
}

/**
 * True when the function only DEFERS its body (see the header): a declaration,
 * a function bound by a declarator, or one handed (directly or inside an
 * object literal argument) to a known deferring registrar. An immediately
 * invoked function is neither: its parent is the call that runs it. Every other
 * function is code that can run while the factory runs.
 */
function defersTheFunction(fn: SgNode): boolean {
	const fnKind = kindOf(fn);
	if (fnKind === "function_declaration") return true;
	if (fnKind === "generator_function_declaration") return true;
	let current: SgNode = fn;
	let viaObject = false;
	// Every kind the walk climbs through (a wrapper, a pair, an object, a call)
	// sits below the program node, so a parent always exists; the last
	// `return false` below is the fall-through for every other parent kind.
	for (;;) {
		const parent = current.parent() as SgNode;
		const parentKind = kindOf(parent);
		if (WRAPPER_KINDS.has(parentKind)) {
			current = parent;
			continue;
		}
		if (parentKind === "pair" && isField(parent, "value", current)) {
			current = parent;
			viaObject = true;
			continue;
		}
		if (parentKind === "object") {
			current = parent;
			viaObject = true;
			continue;
		}
		if (parentKind === "variable_declarator")
			return !viaObject && isField(parent, "value", current);
		if (parentKind === "arguments") {
			const call = parent.parent();
			if (!call || kindOf(call) !== "call_expression") return false;
			if (isDeferringCallee(call.field("function"))) return true;
			// `pi.on("x", wrap(async () => ..))`: a wrapper whose result is the
			// registrar's argument returns the handler it was given; follow the
			// wrapper call out to the registrar.
			current = call;
			viaObject = true;
			continue;
		}
		return false;
	}
}

/**
 * True when `node`, inside the function `root`, runs while `root` runs: no
 * function between them only defers its body.
 */
function runsWithin(node: SgNode, root: SgNode): boolean {
	for (let p = node.parent(); p && !sameNode(p, root); p = p.parent()) {
		if (FUNCTION_KINDS.has(kindOf(p)) && defersTheFunction(p)) return false;
	}
	return true;
}

/** The enclosing declarator's name, or `<top>`. */
function enclosingBinding(node: SgNode, root: SgNode): string {
	for (let p = node.parent(); p && !sameNode(p, root); p = p.parent()) {
		if (kindOf(p) === "variable_declarator") return boundName(p) ?? "<top>";
	}
	return "<top>";
}

/** Classify one reference at factory time, or undefined when it is admitted. */
function refusedForm(node: SgNode): string | undefined {
	const parent = node.parent();
	if (!parent) return "detached";
	const parentKind = kindOf(parent);
	// `x.getFlag`: the reference is the member, and its holder is the parent.
	const holder = kindOf(node) === "property_identifier" ? parent : node;
	const holderParent = holder.parent();
	if (!holderParent) return "detached";
	const holderParentKind = kindOf(holderParent);
	if (
		holderParentKind === "call_expression" &&
		isField(holderParent, "function", holder)
	)
		return "call";
	if (holderParentKind === "arguments") {
		const call = holderParent.parent();
		// The argument of `new Promise(..)` or any other construct is not a
		// stored callback: only a call hands a reader to a callee.
		return call && kindOf(call) === "call_expression"
			? undefined
			: "new-argument";
	}
	if (holderParentKind === "pair" && isField(holderParent, "value", holder)) {
		const object = holderParent.parent();
		if (object && kindOf(object) === "object") {
			const around = object.parent();
			const call = around?.parent();
			if (
				around &&
				kindOf(around) === "arguments" &&
				call &&
				kindOf(call) === "call_expression"
			)
				return undefined;
		}
		return "pair-value";
	}
	if (parentKind === "shorthand_property_identifier") return "shorthand";
	return holderParentKind;
}

/**
 * Scan one source text. `admissions` carries the refused sites the tree
 * admits, each with its reason.
 */
export function scanFactoryFlagReads(
	source: string,
	admissions: FactoryFlagAdmission = {},
): FactoryFlagScan {
	const nodes = parseNodes(stripSource(source));
	const population = populationFunctions(nodes);
	const readers = readerSet(population, nodes);
	const sites: FactoryFlagRead[] = [];
	for (const fn of population) {
		for (const node of within(nodes, fn)) {
			if (sameNode(fn, node)) continue;
			const kind = kindOf(node);
			if (
				kind !== "identifier" &&
				kind !== "property_identifier" &&
				kind !== "shorthand_property_identifier"
			)
				continue;
			const reader = node.text();
			if (!readers.has(reader)) continue;
			const parent = node.parent();
			if (!parent) continue;
			const parentKind = kindOf(parent);
			// A property name counts only as the member of `x.getFlag`.
			if (kind === "property_identifier") {
				if (
					parentKind !== "member_expression" ||
					!isField(parent, "property", node)
				)
					continue;
				if (reader !== "getFlag") continue;
			}
			// A declaration name or an object key is not a use.
			if (
				(parentKind === "variable_declarator" ||
					parentKind === "function_declaration") &&
				isField(parent, "name", node)
			)
				continue;
			if (parentKind === "pair" && isField(parent, "key", node)) continue;
			if (
				parentKind === "formal_parameters" ||
				parentKind === "required_parameter"
			)
				continue;
			// Walk out to the population function: a function that only defers
			// its body (a handler the host calls later) makes the read
			// handler-time; any other function runs while the factory runs.
			const atFactoryTime = runsWithin(node, fn);
			if (!atFactoryTime) continue;
			const form = refusedForm(node);
			if (form === undefined) continue;
			const binding = enclosingBinding(node, fn);
			sites.push({
				line: node.range().start.line + 1,
				reader,
				binding,
				key: `${nameOf(fn)}:${binding}:${reader}:${form}`,
				form,
			});
		}
	}
	const used = new Set(sites.map((site) => site.key));
	return {
		population: population.map((fn) => nameOf(fn)),
		sites,
		unadmitted: sites.filter((site) => !(site.key in admissions)),
		staleAdmissions: Object.keys(admissions).filter((key) => !used.has(key)),
	};
}
