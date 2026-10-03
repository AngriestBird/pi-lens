/**
 * #3763 item 5 / #3824 S2 / #3937 — the mutation bridge's epoch/lineage
 * population.
 *
 * The bridge accepts a foreign `readGuardBranchEpoch` on an entry and resolves
 * it against the live read guard. A well-formed value ABOVE the live epoch is
 * ignored and recorded (never silently skipped), and the entry is then
 * fail-open: it is credited and queued at the current epoch. That direction is
 * safe only because a producer that can name an epoch also captured the
 * lineage that answers currency (the in-process settled sweep). The bridge
 * exposes no epoch to read, so a producer without a lineage cannot learn one;
 * a no-lineage entry carrying an epoch is therefore an invented value.
 *
 * This sweep pins that population: every construction site that can send an
 * epoch into the bridge must also send `lineage`. A future producer that sends
 * an epoch without a lineage reds here, at the construction site, before it can
 * reach the fail-open branch. The behavioural half — that the one real
 * producer's entry carries both — is pinned in
 * `tests/index-observed-sweep-no-read-guard.test.ts`. The producer runtime pin
 * is unchanged and remains the independent witness for released writers.
 *
 * ## #3937: the spread blind spot
 *
 * The first cut read the CALL-SITE object literal's field names. A producer
 * that forwards a previously built object through a spread
 * (`const hidden = { ...entry, readGuardBranchEpoch: 5 };
 * replayThroughMutationBridge({ ...hidden })`) never spells the field at the
 * call site, so it escaped the census entirely — the spelling-enumerator
 * defect shape (AGENTS.md 34). The #3824 follow-up quoted that fixture.
 *
 * This version folds bounded LOCAL provenance instead of matching spellings.
 * Each expression resolves to at most eight possible OUTPUTS, each summarized
 * by whether an epoch and a lineage are guaranteed in that output and whether
 * an unresolved part could add more; the verdict is taken per output, so a
 * conditional's lineage arm cannot launder its epoch-only sibling:
 *
 *   * an object-literal argument contributes its explicit keys (`pair`,
 *     shorthand, method, and a computed STRING-literal key — an unlisted
 *     spelling of the same explicit key), plus the keys of every spread;
 *   * a spread/alias/reference identifier resolves to its nearest SCOPE-AWARE
 *     local binding, whose object-literal initializer is folded recursively;
 *   * `Object.assign(target, ...sources)` folds every argument;
 *   * `a ? b : c` unions both arms as separate outputs; `a && b` is its right
 *     operand (a falsy left is a no-op, never an object); `a || b` / `a ?? b`
 *     union both operands;
 *   * a binding that is ever reassigned, has a property written, is deleted,
 *     or is the target of `Object.assign` is NOT resolved (a stale initializer
 *     must never read as the live value);
 *   * a cycle, a parameter, an import, a call result, a cross-file name, or a
 *     dynamic computed key is UNRESOLVED.
 *
 * The call population enumerates the callee spellings that rebind the bridge:
 * an import rename, a variable alias (`const r = replayThrough…`), a property
 * alias (`const r = mod.replayThrough…`), a destructured binding
 * (`const { replayThrough…: r } = mod`), and a subscript call
 * (`bridge["recordMutation"](…)`). A bridge callee silently absent from the
 * population is the F3 defect this round closes.
 *
 * An unresolved spread leaves the site INDETERMINATE, never falsely safe: the
 * forwarding might carry an epoch. The indeterminate set is registered below
 * with a checked reason and audited in BOTH directions (a new unresolved form
 * fails, and a stale admission fails) via `auditRegistry`. That is the honest
 * statement of coverage — the census proves the resolved population and names
 * the unresolved one; it does not assert whole-population completeness.
 *
 * Known limits, stated rather than papered over:
 *   * cross-file provenance is outside this static fold; a binding whose value
 *     is imported or built in another module resolves to indeterminate;
 *   * TypeScript type resolution is not attempted, so a binding annotated with
 *     a type that lacks the field is still indeterminate unless its initializer
 *     is a resolvable object literal;
 *   * a local function or class that shares a bridge callee's name is still
 *     counted as the bridge — a name collision this fold cannot resolve without
 *     type/module information. The approximation is LOUD: it can red a safe
 *     site, never pass an epoch-without-lineage site as safe. No production
 *     file declares one; a guard pins that population.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** The bridge field whose presence obliges `lineage`. */
const EPOCH_FIELD = "readGuardBranchEpoch";
/** The currency field the epoch obliges. */
const LINEAGE_FIELD = "lineage";

/** The bridge callee names, including local import aliases of them. */
const BRIDGE_CALLEES: ReadonlySet<string> = new Set([
	"recordMutation",
	"replayThroughMutationBridge",
]);

type SiteKind = "safe" | "unsafe" | "indeterminate";

/**
 * The verdict for one bridge construction site.
 *
 * `unsafe`  — the argument can carry an epoch and cannot carry lineage.
 * `indeterminate` — a spread the fold cannot resolve could add an epoch, and
 *   lineage is not present explicitly. Disclosed, never silently clean.
 * `safe` — either no epoch can be present, or lineage is explicit beside it.
 */
interface BridgeSite {
	readonly file: string;
	readonly line: number;
	readonly symbol: string;
	readonly callee: string;
	readonly kind: SiteKind;
	/** Stable per-site identity for the indeterminate admission registry. */
	readonly key: string;
	/**
	 * The census-relevant keys (`readGuardBranchEpoch`, `lineage`) the fold
	 * proved present in at least one possible output of the argument. The
	 * per-output verdict is `kind`: a key present in one alternative of a
	 * conditional is still reported here.
	 */
	readonly keys: ReadonlySet<string>;
	/** True when an unresolved spread/alias could add arbitrary keys. */
	readonly unknown: boolean;
}

/** Function-shaped scopes that own parameter and local bindings. */
const FUNCTION_SCOPE_KINDS: ReadonlySet<string> = new Set([
	"function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"generator_function_declaration",
	"generator_function",
]);

interface Binding {
	readonly name: string;
	readonly scopeId: number;
	readonly value: SgNode | null;
	readonly nodeId: number;
}

/**
 * One possible final object a construction can produce: whether an epoch and a
 * lineage are guaranteed present in that output, and whether an unresolved part
 * could add further keys (an epoch without a lineage, in the worst case).
 *
 * The verdict is per OUTPUT, not per key set: two mutually exclusive
 * conditional arms must not let a lineage key in one launder an epoch-only
 * sibling. Deduping the triples bounds a construction to at most eight outputs,
 * so folding alternatives is not an exponential branch product.
 */
interface Output {
	readonly epoch: boolean;
	readonly lineage: boolean;
	readonly unknown: boolean;
}

interface Construction {
	readonly outputs: readonly Output[];
}

const EMPTY_OUTPUT: Output = { epoch: false, lineage: false, unknown: false };

const UNKNOWN_CONSTRUCTION: Construction = {
	outputs: [{ epoch: false, lineage: false, unknown: true }],
};

function isScope(node: SgNode): boolean {
	return (
		node.kind() === "program" || FUNCTION_SCOPE_KINDS.has(String(node.kind()))
	);
}

/** Strip one layer of matching quotes/backticks from an AST key's text. */
function unquote(text: string): string {
	const first = text.charAt(0);
	const last = text.charAt(text.length - 1);
	if (
		text.length >= 2 &&
		((first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === "`" && last === "`"))
	) {
		return text.slice(1, -1);
	}
	return text;
}

/** Every identifier a parameter pattern can bind (best-effort, never throws). */
function collectPatternNames(node: SgNode, out: string[]): void {
	const kind = node.kind();
	if (kind === "identifier") {
		out.push(node.text());
		return;
	}
	if (
		kind === "formal_parameters" ||
		kind === "object_pattern" ||
		kind === "array_pattern" ||
		kind === "required_parameter" ||
		kind === "optional_parameter" ||
		kind === "rest_pattern"
	) {
		for (const child of node.namedChildren()) collectPatternNames(child, out);
		return;
	}
	if (kind === "assignment_pattern") {
		const left = node.field("left");
		if (left) collectPatternNames(left, out);
	}
}

/**
 * The base identifier of an assignment/update target, so a binding whose state
 * is written after construction is never resolved to a stale initializer.
 */
function rootIdentifierName(node: SgNode | null): string | undefined {
	if (!node) return undefined;
	const kind = node.kind();
	if (kind === "identifier") return node.text();
	if (kind === "member_expression" || kind === "subscript_expression") {
		return rootIdentifierName(node.field("object"));
	}
	if (kind === "parenthesized_expression") {
		return rootIdentifierName(node.namedChildren()[0] ?? null);
	}
	return undefined;
}

function collectMutatedNames(root: SgNode): ReadonlySet<string> {
	const names = new Set<string>();
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		if (
			kind === "assignment_expression" ||
			kind === "augmented_assignment_expression"
		) {
			const name = rootIdentifierName(node.field("left"));
			if (name) names.add(name);
		} else if (kind === "update_expression") {
			const name = rootIdentifierName(node.namedChildren()[0] ?? null);
			if (name) names.add(name);
		} else if (kind === "unary_expression") {
			// `delete x.y` parses as unary_expression whose operator child is
			// `delete`; this grammar has no `delete_expression` kind.
			if (node.children().some((child) => child.kind() === "delete")) {
				const name = rootIdentifierName(node.namedChildren()[0] ?? null);
				if (name) names.add(name);
			}
		} else if (kind === "call_expression") {
			// `Object.assign(target, ...)` mutates target, so a later read of the
			// binding cannot resolve to its stale initializer.
			const fn = node.field("function");
			if (
				fn?.kind() === "member_expression" &&
				fn.field("object")?.text() === "Object" &&
				fn.field("property")?.text() === "assign"
			) {
				const target = node.field("arguments")?.namedChildren()[0] ?? null;
				const name = rootIdentifierName(target);
				if (name) names.add(name);
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return names;
}

function buildBindings(root: SgNode): Binding[] {
	const bindings: Binding[] = [];
	const stack: SgNode[] = [];
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		const scope = isScope(node);
		if (scope) stack.push(node);
		const owner = stack[stack.length - 1] ?? root;
		if (kind === "variable_declarator") {
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				bindings.push({
					name: name.text(),
					scopeId: owner.id(),
					value: node.field("value"),
					nodeId: node.id(),
				});
			}
		} else if (FUNCTION_SCOPE_KINDS.has(String(kind))) {
			const parameters = node.field("parameters");
			if (parameters) {
				const names: string[] = [];
				collectPatternNames(parameters, names);
				for (const name of names) {
					bindings.push({
						name,
						scopeId: owner.id(),
						value: null,
						nodeId: node.id(),
					});
				}
			}
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				bindings.push({
					name: name.text(),
					scopeId: owner.id(),
					value: null,
					nodeId: node.id(),
				});
			}
		} else if (kind === "class_declaration") {
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				bindings.push({
					name: name.text(),
					scopeId: owner.id(),
					value: null,
					nodeId: node.id(),
				});
			}
		} else if (kind === "import_specifier") {
			const alias = node.field("alias");
			const imported = node.field("name");
			const local = alias?.kind() === "identifier" ? alias : imported;
			if (local?.kind() === "identifier") {
				bindings.push({
					name: local.text(),
					scopeId: owner.id(),
					value: null,
					nodeId: node.id(),
				});
			}
		} else if (kind === "import_clause") {
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				bindings.push({
					name: name.text(),
					scopeId: owner.id(),
					value: null,
					nodeId: node.id(),
				});
			}
		}
		for (const child of node.children()) visit(child);
		if (scope) stack.pop();
	};
	visit(root);
	return bindings;
}

/**
 * The bridge callee a call names, across the callable spellings the census
 * enumerates: `recordMutation`, `bridge.recordMutation`, `bridge["recordMutation"]`,
 * `(bridge.recordMutation)`, and any local alias of them (resolved separately by
 * `collectCalleeNames`).
 */
function calleeName(fn: SgNode | null): string | undefined {
	if (!fn) return undefined;
	const kind = fn.kind();
	if (kind === "identifier") return fn.text();
	if (kind === "member_expression") return fn.field("property")?.text();
	if (kind === "subscript_expression") {
		const index = fn.field("index");
		if (!index) return undefined;
		if (index.kind() === "string" || index.kind() === "template_string") {
			return unquote(index.text());
		}
		if (
			index.kind() === "identifier" ||
			index.kind() === "property_identifier"
		) {
			return index.text();
		}
		return undefined;
	}
	if (kind === "parenthesized_expression") {
		return calleeName(fn.namedChildren()[0] ?? null);
	}
	return undefined;
}

/** Every local name an object pattern binds to a bridge callee's key. */
function collectObjectPatternAliases(
	pattern: SgNode,
	out: Array<{ name: string; value: string }>,
): void {
	for (const binding of pattern.namedChildren()) {
		const kind = binding.kind();
		if (kind === "shorthand_property_identifier_pattern") {
			out.push({ name: binding.text(), value: binding.text() });
			continue;
		}
		if (kind !== "pair_pattern") continue;
		const parts = binding.namedChildren();
		const key = parts[0]?.text();
		const local = parts[parts.length - 1];
		if (!key || !local) continue;
		if (local.kind() === "identifier") {
			out.push({ name: local.text(), value: key });
		} else if (local.kind() === "object_pattern") {
			collectObjectPatternAliases(local, out);
		}
	}
}

/** The callee names this file can call the bridge through, import aliases included. */
function collectCalleeNames(root: SgNode): ReadonlySet<string> {
	const names = new Set<string>(BRIDGE_CALLEES);
	const aliases: Array<{ name: string; value: string }> = [];
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		if (kind === "import_specifier") {
			const imported = node.field("name");
			const alias = node.field("alias");
			if (
				imported &&
				alias?.kind() === "identifier" &&
				BRIDGE_CALLEES.has(imported.text())
			) {
				names.add(alias.text());
			}
		} else if (kind === "variable_declarator") {
			const name = node.field("name");
			if (name?.kind() === "identifier") {
				const terminal = calleeName(node.field("value"));
				if (terminal !== undefined) {
					aliases.push({ name: name.text(), value: terminal });
				}
			} else if (name?.kind() === "object_pattern") {
				collectObjectPatternAliases(name, aliases);
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	// A local alias of the bridge function (`const replay = replayThroughMutationBridge`)
	// is the same seam under a different name, whether it comes from an import
	// rename, a variable or property alias, or a destructured binding. Close over
	// chains of aliases so one hop cannot hide the call.
	let changed = true;
	while (changed) {
		changed = false;
		for (const alias of aliases) {
			if (names.has(alias.value) && !names.has(alias.name)) {
				names.add(alias.name);
				changed = true;
			}
		}
	}
	return names;
}

/**
 * A parse-error region that names a bridge callee means the walk cannot trust
 * its own population for this file. That is a hard failure naming the file and
 * line, never a silent skip: the error region may hold the very construction
 * the census guards.
 */
function findMalformedBridgeRegion(
	root: SgNode,
): { line: number; text: string } | undefined {
	let found: { line: number; text: string } | undefined;
	const visit = (node: SgNode): void => {
		if (found) return;
		if (node.kind() === "ERROR") {
			const text = node.text();
			if ([...BRIDGE_CALLEES].some((callee) => text.includes(callee))) {
				found = { line: node.range().start.line + 1, text: text.slice(0, 120) };
				return;
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return found;
}

/** The name of the nearest enclosing function/class, for the site identity. */
function enclosingSymbol(node: SgNode): string {
	for (const ancestor of node.ancestors()) {
		const kind = ancestor.kind();
		if (FUNCTION_SCOPE_KINDS.has(String(kind))) {
			const name = ancestor.field("name");
			if (name?.kind() === "identifier") return name.text();
			const parent = ancestor.parent();
			if (parent?.kind() === "variable_declarator") {
				const declared = parent.field("name");
				if (declared?.kind() === "identifier") return declared.text();
			}
		}
		if (kind === "class_declaration") {
			const name = ancestor.field("name");
			if (name?.kind() === "identifier") return name.text();
		}
	}
	return "<module>";
}

function makeResolver(root: SgNode): (node: SgNode | null) => Construction {
	const bindings = buildBindings(root);
	const mutated = collectMutatedNames(root);
	const byName = new Map<string, Binding[]>();
	for (const binding of bindings) {
		const list = byName.get(binding.name) ?? [];
		list.push(binding);
		byName.set(binding.name, list);
	}

	const findBinding = (identifier: SgNode): Binding | undefined => {
		const scopes: number[] = [];
		let current: SgNode | null = identifier.parent();
		while (current) {
			if (isScope(current)) scopes.push(current.id());
			current = current.parent();
		}
		const candidates = byName.get(identifier.text()) ?? [];
		for (const scopeId of scopes) {
			const inScope = candidates.filter(
				(candidate) => candidate.scopeId === scopeId,
			);
			if (inScope.length === 1) return inScope[0];
			// Two same-named bindings in one scope: a shadow we cannot order.
			if (inScope.length > 1) return undefined;
		}
		return undefined;
	};

	/** Distinct output profiles, deduped by `(epoch, lineage, unknown)`. */
	const dedupe = (outputs: readonly Output[]): Output[] => {
		const byProfile = new Map<string, Output>();
		for (const output of outputs) {
			const profile = `${output.epoch ? "e" : "-"}${output.lineage ? "l" : "-"}${output.unknown ? "u" : "-"}`;
			if (!byProfile.has(profile)) byProfile.set(profile, output);
		}
		return [...byProfile.values()];
	};

	/** Both expressions can be the result (a conditional, `||`, or `??`). */
	const unionConstructions = (
		left: Construction,
		right: Construction,
	): Construction => ({ outputs: dedupe([...left.outputs, ...right.outputs]) });

	/** The result carries the keys of both (a spread). */
	const combineConstructions = (
		left: Construction,
		right: Construction,
	): Construction => {
		const outputs: Output[] = [];
		for (const a of left.outputs) {
			for (const b of right.outputs) {
				outputs.push({
					epoch: a.epoch || b.epoch,
					lineage: a.lineage || b.lineage,
					unknown: a.unknown || b.unknown,
				});
			}
		}
		return { outputs: dedupe(outputs) };
	};

	const addKey = (
		construction: Construction,
		key: string | undefined,
	): Construction => {
		if (key !== EPOCH_FIELD && key !== LINEAGE_FIELD) return construction;
		return {
			outputs: construction.outputs.map((output) => ({
				epoch: output.epoch || key === EPOCH_FIELD,
				lineage: output.lineage || key === LINEAGE_FIELD,
				unknown: output.unknown,
			})),
		};
	};

	const markUnknown = (construction: Construction): Construction => ({
		outputs: construction.outputs.map((output) => ({
			...output,
			unknown: true,
		})),
	});

	const resolveKey = (
		key: SgNode | null,
	): { key?: string; dynamic: boolean } => {
		if (!key) return { dynamic: true };
		const kind = key.kind();
		if (kind === "property_identifier" || kind === "identifier") {
			return { key: key.text(), dynamic: false };
		}
		if (kind === "string" || kind === "template_string") {
			return { key: unquote(key.text()), dynamic: false };
		}
		if (kind === "computed_property_name") {
			const inner = key.namedChildren()[0];
			if (
				inner &&
				(inner.kind() === "string" || inner.kind() === "template_string")
			) {
				return { key: unquote(inner.text()), dynamic: false };
			}
			return { dynamic: true };
		}
		return { dynamic: true };
	};

	const resolveObject = (
		node: SgNode,
		visiting: ReadonlySet<number>,
	): Construction => {
		let result: Construction = { outputs: [EMPTY_OUTPUT] };
		for (const property of node.namedChildren()) {
			const kind = property.kind();
			if (kind === "pair") {
				const resolved = resolveKey(property.field("key") ?? property);
				result = resolved.dynamic
					? markUnknown(result)
					: addKey(result, resolved.key);
			} else if (kind === "shorthand_property_identifier") {
				result = addKey(result, property.text());
			} else if (kind === "method_definition") {
				const resolved = resolveKey(property.field("name") ?? property);
				result = resolved.dynamic
					? markUnknown(result)
					: addKey(result, resolved.key);
			} else if (kind === "spread_element") {
				result = combineConstructions(
					result,
					resolve(property.namedChildren()[0] ?? null, visiting),
				);
			} else {
				result = markUnknown(result);
			}
		}
		return result;
	};

	const resolveObjectAssign = (
		node: SgNode,
		visiting: ReadonlySet<number>,
	): Construction => {
		const fn = node.field("function");
		if (
			fn?.kind() !== "member_expression" ||
			fn.field("object")?.text() !== "Object" ||
			fn.field("property")?.text() !== "assign"
		) {
			return UNKNOWN_CONSTRUCTION;
		}
		let result: Construction = { outputs: [EMPTY_OUTPUT] };
		for (const argument of node.field("arguments")?.namedChildren() ?? []) {
			result = combineConstructions(result, resolve(argument, visiting));
		}
		return result;
	};

	const resolve = (
		node: SgNode | null,
		visiting: ReadonlySet<number>,
	): Construction => {
		if (!node) return UNKNOWN_CONSTRUCTION;
		const kind = node.kind();
		if (kind === "object") return resolveObject(node, visiting);
		if (kind === "identifier") {
			const binding = findBinding(node);
			if (!binding || !binding.value || mutated.has(binding.name)) {
				return UNKNOWN_CONSTRUCTION;
			}
			if (visiting.has(binding.nodeId)) return UNKNOWN_CONSTRUCTION;
			const next = new Set(visiting);
			next.add(binding.nodeId);
			return resolve(binding.value, next);
		}
		if (kind === "parenthesized_expression") {
			return resolve(node.namedChildren()[0] ?? null, visiting);
		}
		if (
			kind === "as_expression" ||
			kind === "satisfies_expression" ||
			kind === "type_assertion" ||
			kind === "non_null_expression"
		) {
			return resolve(
				node.field("expression") ?? node.namedChildren()[0] ?? null,
				visiting,
			);
		}
		if (kind === "ternary_expression" || kind === "conditional_expression") {
			return unionConstructions(
				resolve(node.field("consequence"), visiting),
				resolve(node.field("alternative"), visiting),
			);
		}
		if (kind === "binary_expression") {
			const operator = node.field("operator")?.text();
			// `a && b` is `b` when the guard holds and the falsy `a` otherwise; a
			// falsy operand spreads nothing and is never the object result. Taking
			// only the right operand keeps a guarded `...(lineage && { lineage })`
			// safe instead of unknown.
			if (operator === "&&") return resolve(node.field("right"), visiting);
			if (operator === "||" || operator === "??") {
				return unionConstructions(
					resolve(node.field("left"), visiting),
					resolve(node.field("right"), visiting),
				);
			}
			return UNKNOWN_CONSTRUCTION;
		}
		if (kind === "call_expression") return resolveObjectAssign(node, visiting);
		return UNKNOWN_CONSTRUCTION;
	};

	return (node) => resolve(node, new Set<number>());
}

/**
 * The verdict over every possible output. `unsafe` dominates: one arm with a
 * definite epoch and no lineage reds the whole construction even if another arm
 * looks safe. `indeterminate` means no arm is definitely unsafe, but an
 * unresolved arm could still carry an epoch without a lineage.
 */
function classify(construction: Construction): SiteKind {
	let indeterminate = false;
	for (const output of construction.outputs) {
		if (output.epoch && !output.lineage) return "unsafe";
		if (output.unknown && !output.lineage) indeterminate = true;
	}
	return indeterminate ? "indeterminate" : "safe";
}

/** The census-relevant keys present in at least one possible output. */
function censusKeys(construction: Construction): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const output of construction.outputs) {
		if (output.epoch) keys.add(EPOCH_FIELD);
		if (output.lineage) keys.add(LINEAGE_FIELD);
	}
	return keys;
}

/**
 * A file that never spells a bridge callee cannot call one, directly or
 * through an import alias (the alias still imports the original name). This is
 * a lexical ADMISSION check only: every admitted match still comes from the
 * AST below, so a callee named only in a comment or string is filtered out by
 * the walk, not by this probe.
 */
function mightContainBridgeCallee(source: string): boolean {
	for (const callee of BRIDGE_CALLEES) {
		if (source.includes(callee)) return true;
	}
	return false;
}

/**
 * Every bridge construction site in one source text, with its local-provenance
 * verdict. Exported through a test-visible seam (called directly by the
 * fixture cases below) so a regression in the fold is caught on synthetic code
 * before it hides behind the whole-tree census.
 */
function analyzeBridgeSites(source: string, file: string): BridgeSite[] {
	if (!mightContainBridgeCallee(source)) return [];
	const root = parse(Lang.TypeScript, source).root();
	const malformed = findMalformedBridgeRegion(root);
	if (malformed) {
		throw new Error(
			`mutation-bridge census: malformed source at ${file}:${malformed.line} names a bridge callee inside a parse error; the construction population cannot be read: ${JSON.stringify(malformed.text)}`,
		);
	}
	const calleeNames = collectCalleeNames(root);
	const resolve = makeResolver(root);
	const sites: BridgeSite[] = [];
	const visit = (node: SgNode): void => {
		if (node.kind() === "call_expression") {
			const callee = calleeName(node.field("function"));
			if (callee !== undefined && calleeNames.has(callee)) {
				const args = node.field("arguments")?.namedChildren() ?? [];
				const construction =
					args.length === 1 ? resolve(args[0] ?? null) : UNKNOWN_CONSTRUCTION;
				const symbol = enclosingSymbol(node);
				sites.push({
					file,
					line: node.range().start.line + 1,
					symbol,
					callee,
					kind: classify(construction),
					key: `${file}::${symbol}::${callee}`,
					keys: censusKeys(construction),
					unknown: construction.outputs.some((output) => output.unknown),
				});
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return sites;
}

/** Bridge source roots: runtime and adapter trees plus the pi host entry. */
function productionSourceFiles(): string[] {
	const files: string[] = [];
	for (const root of ["clients", "tools", "mcp", "scripts"]) {
		const dir = path.join(REPO_ROOT, root);
		if (fs.existsSync(dir)) {
			files.push(...listSourceFiles(dir, { skipTests: true }));
		}
	}
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files;
}

let cachedSites: BridgeSite[] | undefined;
function productionSites(): BridgeSite[] {
	cachedSites ??= productionSourceFiles().flatMap((file) =>
		analyzeBridgeSites(
			fs.readFileSync(file, "utf8"),
			relativePosix(REPO_ROOT, file),
		),
	);
	return cachedSites;
}

/**
 * Bridge callee names a file declares with a `function`, `class`, or top-level
 * `const`/`let`/`var`. A local declaration sharing a bridge name is the shape the
 * fold cannot tell from the bridge (F5): it is counted as the bridge, which can
 * red a safe site but never passes an epoch-without-lineage site. This measures
 * that population so a real shadow has to be assessed rather than assumed.
 */
function localBridgeDeclarations(source: string): string[] {
	if (!mightContainBridgeCallee(source)) return [];
	const root = parse(Lang.TypeScript, source).root();
	const declared = new Set<string>();
	const visit = (node: SgNode): void => {
		const kind = node.kind();
		if (kind === "function_declaration" || kind === "class_declaration") {
			const name = node.field("name");
			if (name?.kind() === "identifier" && BRIDGE_CALLEES.has(name.text())) {
				declared.add(name.text());
			}
		} else if (kind === "variable_declarator") {
			const name = node.field("name");
			if (name?.kind() === "identifier" && BRIDGE_CALLEES.has(name.text())) {
				declared.add(name.text());
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	return [...declared];
}

/**
 * Every forwarding site the local fold cannot resolve. Each carries a checked
 * reason; the audit below fails on a new one (a new unsupported form) and on a
 * stale one (a resolved form), so the list can only stay honest.
 */
const ADMITTED_INDETERMINATE: Readonly<Record<string, string>> = {
	"clients/observed-mutation-sources.ts::replayThroughMutationBridge::recordMutation":
		"the generic replay seam forwards a caller-built entry; its two in-tree callers construct lineage at the call site",
};

describe("#3824 S2 / #3937: a bridge entry names its lineage whenever it can name an epoch", () => {
	it("no resolvable construction site carries an epoch without lineage", () => {
		const sites = productionSites();
		assertNonEmptyScan("bridge entry construction sites", sites.length, 1);
		const epochSites = sites.filter((site) => site.keys.has(EPOCH_FIELD));
		// Floor: the one real epoch sender (the settled sweep) is in the census,
		// so a dead scan or a moved producer cannot read as clean.
		assertNonEmptyScan("epoch-carrying bridge entries", epochSites.length, 1);
		const unsafe = sites
			.filter((site) => site.kind === "unsafe")
			.map((site) => `${site.file}:${site.line} (${site.callee})`);
		expect(unsafe, "epoch-carrying construction without lineage").toEqual([]);
	});

	it("no production file declares a bridge callee name beyond the bridge definition", () => {
		const declaringFiles = productionSourceFiles()
			.map((file) => ({
				file: relativePosix(REPO_ROOT, file),
				declared: localBridgeDeclarations(fs.readFileSync(file, "utf8")),
			}))
			.filter((entry) => entry.declared.length > 0);
		// The only production declaration is the bridge itself. A second one must
		// be assessed here, because the fold would count it as the bridge and could
		// red a safe producer (loud, never false-clean).
		expect(declaringFiles).toEqual([
			{
				file: "clients/observed-mutation-sources.ts",
				declared: ["replayThroughMutationBridge"],
			},
		]);
	});

	it("every unresolved forwarding site is admitted with a checked reason", () => {
		const indeterminate = productionSites()
			.filter((site) => site.kind === "indeterminate")
			.map((site) => ({ key: site.key, detail: `${site.file}:${site.line}` }));
		const audit = auditRegistry({
			sweepName: "mutation-bridge epoch/lineage indeterminate coverage",
			flagged: indeterminate,
			registered: [],
			exemptions: ADMITTED_INDETERMINATE,
			// The set is legitimately empty when every forwarding site resolves;
			// `assertNonEmptyScan` above is the population floor for the scan.
			minFlagged: 0,
			minReasonLength: 20,
			remediation:
				"Resolve the forwarding with the bounded local fold, or admit it above with a reason it cannot carry an epoch without lineage.",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});

describe("#3937: bounded local object/spread provenance", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	it("flags the quoted spread-forwarded epoch without lineage", () => {
		const site = only(`
			function replayCaller(entry: unknown) {
				const hiddenEntry = { ...entry, readGuardBranchEpoch: 5 };
				replayThroughMutationBridge({ ...hiddenEntry });
			}
		`);
		expect(site.kind).toBe("unsafe");
		// The failure must name the file and the seam, so a red is actionable.
		expect(site.file).toBe("fixture.ts");
		expect(site.callee).toBe("replayThroughMutationBridge");
		expect(site.line).toBe(4);
	});

	it("passes a benign spread that carries the lineage", () => {
		const site = only(`
			function replayCaller(entry: unknown, lineage: unknown) {
				const safeEntry = { ...entry, lineage };
				replayThroughMutationBridge({ ...safeEntry });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("passes a legacy lineage-only construction with no epoch", () => {
		const site = only(`
			function replayCaller(lineage: unknown) {
				replayThroughMutationBridge({ lineage });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not count a type declaration as a construction site", () => {
		expect(
			analyze(`
				interface ObservedReplayEntry {
					readGuardBranchEpoch?: number;
					lineage?: unknown;
				}
			`),
		).toEqual([]);
	});

	it("resolves a local const alias and an Object.assign source", () => {
		const viaAlias = only(`
			function replayCaller(epoch: number) {
				const built = { readGuardBranchEpoch: epoch };
				replayThroughMutationBridge(built);
			}
		`);
		expect(viaAlias.kind).toBe("unsafe");
		const viaAssign = only(`
			function replayCaller(epoch: number) {
				replayThroughMutationBridge(
					Object.assign({}, { readGuardBranchEpoch: epoch }),
				);
			}
		`);
		expect(viaAssign.kind).toBe("unsafe");
	});

	it("sees an import-renamed replay call as an unlisted spelling", () => {
		const site = only(`
			import { replayThroughMutationBridge as replay } from "./observed-mutation-sources.js";
			function run(epoch: number) {
				replay({ readGuardBranchEpoch: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a variable-renamed replay function as an unlisted spelling", () => {
		const site = only(`
			function run(epoch: number) {
				const replay = replayThroughMutationBridge;
				replay({ readGuardBranchEpoch: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("fails loudly when a bridge construction sits inside a parse error", () => {
		expect(() =>
			analyze(
				`function f( { replayThroughMutationBridge({ readGuardBranchEpoch: 1 })`,
			),
		).toThrow(/fixture\.ts:1.*parse error/);
	});

	it("sees a computed string-literal key as the explicit key it spells", () => {
		const site = only(`
			function replayCaller(epoch: number) {
				replayThroughMutationBridge({ ["readGuardBranchEpoch"]: epoch });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("does not treat a call named only in a comment or a string as a site", () => {
		expect(
			analyze(`
				// replayThroughMutationBridge({ readGuardBranchEpoch: 5 })
				const note = "replayThroughMutationBridge({ readGuardBranchEpoch: 5 })";
			`),
		).toEqual([]);
	});

	it("treats an unresolved spread as indeterminate, never safe", () => {
		const site = only(`
			function replayCaller(entry: unknown) {
				replayThroughMutationBridge({ ...entry });
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	it("treats a cycle, a reassignment, and a shadow conservatively", () => {
		const cyclic = only(`
			function replayCaller() {
				const a = { ...b, readGuardBranchEpoch: 5 };
				const b = { ...a };
				replayThroughMutationBridge(a);
			}
		`);
		// A self-reference cycle leaves the epoch definite and the lineage
		// unprovable, so the site is `unsafe` (the loud verdict), not silent.
		expect(cyclic.kind).toBe("unsafe");
		const reassigned = only(`
			function replayCaller(epoch: number) {
				let built = { lineage: 1 };
				built = { readGuardBranchEpoch: epoch };
				replayThroughMutationBridge(built);
			}
		`);
		expect(reassigned.kind).not.toBe("safe");
		const shadowed = only(`
			const hidden = { lineage: 1 };
			function replayCaller(hidden: unknown) {
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(shadowed.kind).not.toBe("safe");
	});
});

describe("#3937 review round 2 — per-output soundness and callee/mutation coverage", () => {
	const analyze = (source: string): BridgeSite[] =>
		analyzeBridgeSites(source, "fixture.ts");
	const only = (source: string): BridgeSite => {
		const sites = analyze(source);
		expect(sites).toHaveLength(1);
		return sites[0] as BridgeSite;
	};

	// F1 — a conditional's arms are mutually exclusive; a lineage key in one arm
	// must not launder an epoch-only sibling into a safe verdict.
	it("flags a heterogeneous conditional whose epoch arm lacks lineage", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				replayThroughMutationBridge(cond ? { lineage: 1 } : { readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("flags a conditional whose epoch arm is only partially repaired", () => {
		const site = only(`
			function replayCaller(cond: boolean, entry: unknown) {
				const hidden = cond ? { ...entry, readGuardBranchEpoch: 5 } : { lineage: 1 };
				replayThroughMutationBridge({ ...hidden });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("does not drop an outer lineage overlay over a conditional", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				const hidden = cond ? { readGuardBranchEpoch: 5 } : {};
				replayThroughMutationBridge({ ...hidden, lineage: 1 });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	it("does not let an unrelated lineage arm launder a short-circuit epoch arm", () => {
		const site = only(`
			function replayCaller(cond: boolean) {
				const hidden = (cond && { lineage: 1 }) || { readGuardBranchEpoch: 5 };
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("models a && spread as its right operand so a guarded lineage arm stays safe", () => {
		const site = only(`
			function replayCaller(lineage: unknown) {
				replayThroughMutationBridge({ ...(lineage && { lineage }) });
			}
		`);
		expect(site.kind).toBe("safe");
	});

	// F2 — the pinned TypeScript grammar parses `delete x.y` as unary_expression
	// (children `delete`, `member_expression`), never `delete_expression`.
	it("treats a post-construction delete of lineage as unresolved", () => {
		const site = only(`
			function replayCaller() {
				const hidden: any = { lineage: 1, readGuardBranchEpoch: 5 };
				delete hidden.lineage;
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).not.toBe("safe");
	});

	// F3 — a bridge callee rebound through destructuring, a property alias, or a
	// subscript is still the same seam; it must be a site, never silently zero.
	it("sees a destructured bridge callee alias", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			const { replayThroughMutationBridge: replay } = mod;
			function run() {
				replay({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a property-aliased bridge callee", () => {
		const site = only(`
			import * as mod from "./observed-mutation-sources.js";
			const replay = mod.replayThroughMutationBridge;
			function run() {
				replay({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	it("sees a subscript bridge callee", () => {
		const site = only(`
			function run() {
				bridge["recordMutation"]({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});

	// F4 — Object.assign(target, ...) mutates target, so a later read of the
	// binding cannot resolve to the stale initializer. It read as unsafe before.
	it("treats an Object.assign target as unresolved rather than stale", () => {
		const site = only(`
			function replayCaller() {
				const hidden = { readGuardBranchEpoch: 5 };
				Object.assign(hidden, { lineage: 1 });
				replayThroughMutationBridge(hidden);
			}
		`);
		expect(site.kind).toBe("indeterminate");
	});

	// F5 — a local function that shadows a bridge name is conservatively flagged
	// (loud over-approximation). No production file has this shape; the measured
	// guard below pins that population so a real shadow must be assessed.
	it("conservatively flags a same-name local function shadow", () => {
		const site = only(`
			function replayThroughMutationBridge(x: unknown) { return x; }
			function run() {
				replayThroughMutationBridge({ readGuardBranchEpoch: 5 });
			}
		`);
		expect(site.kind).toBe("unsafe");
	});
});
