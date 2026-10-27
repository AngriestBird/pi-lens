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
 * Population: the body of every module-level function the default export
 * calls (today `activateExtension`), parsed from COMMENT-AND-STRING-BLANKED
 * text (`stripSource`, so a comment that quotes `getLensFlag(` is not a read),
 * through the census AST seam (`ast-census.ts`).
 *
 * The reader set R is the base names {@link BASE_READERS} plus, by fixpoint,
 * every function-valued binding or declaration in the population whose text
 * references a member of R. An indirect read (`const read = () =>
 * getLensFlag(..); read()`) is therefore a read at the call to `read`.
 *
 * A reference to a member of R is classified by where it sits. The detector
 * ADMITS a short list of forms and REFUSES every other:
 *
 * - inside a nested function that is not a synchronous array callback: the
 *   host calls it later (a handler, a tool `execute`, a command), admitted;
 * - a declaration name, or an object-literal key: not a use, admitted;
 * - an argument of a call, or the value of a pair in an object literal that is
 *   itself a call argument: the reader is handed to a callee that stores it,
 *   admitted. RESIDUAL, named: a callee that invokes its argument
 *   synchronously reads at factory time, and this scan cannot see into it;
 * - anything else at factory time, which includes a call to a reader, a read
 *   inside a synchronous array callback (`.filter((t) => isToolEnabled(..))`),
 *   an alias binding, an assignment right-hand side, an array element,
 *   `.call`/`.apply`/`.bind` on a reader, and a destructuring: REFUSED, unless
 *   an {@link FactoryFlagAdmission} row keyed `<binding>:<reader>` carries its
 *   reason.
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
	/** `binding:reader`, the admission key. */
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

/** Array iteration methods whose callback runs before the call returns. */
const SYNC_CALLBACK_METHODS = new Set([
	"filter",
	"map",
	"flatMap",
	"some",
	"every",
	"find",
	"findIndex",
	"forEach",
	"reduce",
	"sort",
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

/** Module-level functions the default export calls by name. */
function populationFunctions(nodes: SgNode[]): SgNode[] {
	const exported = nodes.find(
		(node) =>
			kindOf(node) === "export_statement" &&
			node.text().startsWith("export default"),
	);
	if (!exported) throw new Error("factory-flag scan: no default export found");
	const called = new Set(
		within(nodes, exported)
			.filter((node) => kindOf(node) === "call_expression")
			.map((node) => node.field("function"))
			.filter((callee): callee is SgNode => callee !== null)
			.filter((callee) => kindOf(callee) === "identifier")
			.map((callee) => callee.text()),
	);
	return nodes.filter(
		(node) =>
			kindOf(node) === "function_declaration" &&
			kindOf(node.parent() as SgNode) === "program" &&
			called.has(boundName(node) ?? ""),
	);
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

/** The synchronous-ness of one function ancestor between a site and its fn. */
function runsBeforeFactoryReturns(fn: SgNode): boolean {
	if (kindOf(fn) !== "arrow_function" && kindOf(fn) !== "function_expression")
		return false;
	const args = fn.parent();
	if (!args || kindOf(args) !== "arguments") return false;
	const call = args.parent();
	if (!call || kindOf(call) !== "call_expression") return false;
	const callee = call.field("function");
	if (!callee || kindOf(callee) !== "member_expression") return false;
	const method = callee.field("property")?.text() ?? "";
	return SYNC_CALLBACK_METHODS.has(method);
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
	if (holderParentKind === "arguments") return undefined;
	if (holderParentKind === "pair" && isField(holderParent, "value", holder)) {
		const object = holderParent.parent();
		if (object && kindOf(object) === "object") {
			const around = object.parent();
			if (around && kindOf(around) === "arguments") return undefined;
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
			// Walk out to the population function: a nested function that the
			// host calls later makes the read handler-time.
			let atFactoryTime = true;
			for (
				let p: SgNode | null = parent;
				p && !sameNode(p, fn);
				p = p.parent()
			) {
				if (FUNCTION_KINDS.has(kindOf(p)) && !runsBeforeFactoryReturns(p)) {
					atFactoryTime = false;
					break;
				}
			}
			if (!atFactoryTime) continue;
			const form = refusedForm(node);
			if (form === undefined) continue;
			const binding = enclosingBinding(node, fn);
			sites.push({
				line: node.range().start.line + 1,
				reader,
				binding,
				key: `${binding}:${reader}`,
				form,
			});
		}
	}
	const used = new Set(sites.map((site) => site.key));
	return {
		population: population.map((fn) => boundName(fn) ?? "<anonymous>"),
		sites,
		unadmitted: sites.filter((site) => !(site.key in admissions)),
		staleAdmissions: Object.keys(admissions).filter((key) => !used.has(key)),
	};
}
