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
 * This version folds bounded LOCAL provenance instead of matching spellings:
 *
 *   * an object-literal argument contributes its explicit keys (`pair`,
 *     shorthand, method, and a computed STRING-literal key — an unlisted
 *     spelling of the same explicit key), plus the keys of every spread;
 *   * a spread/alias/reference identifier resolves to its nearest SCOPE-AWARE
 *     local binding, whose object-literal initializer is folded recursively;
 *   * `Object.assign(target, ...sources)` folds every argument;
 *   * `cond && {...}` / `a ? b : c` fold both arms;
 *   * a binding that is ever reassigned or has a property written is NOT
 *     resolved (a stale initializer must never read as the live value);
 *   * a cycle, a parameter, an import, a call result, a cross-file name, or a
 *     dynamic computed key is UNRESOLVED.
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
 *   * a bridge function aliased through a variable (`const r = replayThrough…`)
 *     is not in the call population (an import alias IS, see the fixture).
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
	/** Keys the fold proved present on the constructed argument. */
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

interface Construction {
	readonly keys: ReadonlySet<string>;
	readonly unknown: boolean;
}

const UNKNOWN_CONSTRUCTION: Construction = {
	keys: new Set<string>(),
	unknown: true,
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
		} else if (kind === "update_expression" || kind === "delete_expression") {
			const name = rootIdentifierName(node.namedChildren()[0] ?? null);
			if (name) names.add(name);
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
			const value = node.field("value");
			if (name?.kind() === "identifier" && value?.kind() === "identifier") {
				aliases.push({ name: name.text(), value: value.text() });
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	// A local alias of the bridge function (`const replay = replayThroughMutationBridge`)
	// is the same seam under a different name. Close over chains of aliases so
	// one hop cannot hide the call.
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

	const union = (left: Construction, right: Construction): Construction => ({
		keys: new Set([...left.keys, ...right.keys]),
		unknown: left.unknown || right.unknown,
	});

	const resolveKey = (key: SgNode): { key?: string; dynamic: boolean } => {
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
		const keys = new Set<string>();
		let unknown = false;
		for (const property of node.namedChildren()) {
			const kind = property.kind();
			if (kind === "pair") {
				const { key, dynamic } = resolveKey(property.field("key") ?? property);
				if (dynamic) unknown = true;
				else if (key !== undefined) keys.add(key);
			} else if (kind === "shorthand_property_identifier") {
				keys.add(property.text());
			} else if (kind === "method_definition") {
				const { key, dynamic } = resolveKey(property.field("name") ?? property);
				if (dynamic) unknown = true;
				else if (key !== undefined) keys.add(key);
			} else if (kind === "spread_element") {
				const inner = resolve(property.namedChildren()[0] ?? null, visiting);
				for (const spreadKey of inner.keys) keys.add(spreadKey);
				unknown = unknown || inner.unknown;
			} else {
				unknown = true;
			}
		}
		return { keys, unknown };
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
		let result: Construction = { keys: new Set<string>(), unknown: false };
		for (const argument of node.field("arguments")?.namedChildren() ?? []) {
			result = union(result, resolve(argument, visiting));
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
			return union(
				resolve(node.field("consequence"), visiting),
				resolve(node.field("alternative"), visiting),
			);
		}
		if (kind === "binary_expression") {
			return union(
				resolve(node.field("left"), visiting),
				resolve(node.field("right"), visiting),
			);
		}
		if (kind === "call_expression") return resolveObjectAssign(node, visiting);
		return UNKNOWN_CONSTRUCTION;
	};

	return (node) => resolve(node, new Set<number>());
}

function classify(construction: Construction): SiteKind {
	const hasEpoch = construction.keys.has(EPOCH_FIELD);
	const hasLineage = construction.keys.has(LINEAGE_FIELD);
	if (hasEpoch && !hasLineage) return "unsafe";
	if (!hasLineage && construction.unknown) return "indeterminate";
	return "safe";
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
			const fn = node.field("function");
			const callee =
				fn?.kind() === "identifier"
					? fn.text()
					: fn?.kind() === "member_expression"
						? fn.field("property")?.text()
						: undefined;
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
					keys: construction.keys,
					unknown: construction.unknown,
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
		expect(cyclic.kind).not.toBe("safe");
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
