/**
 * The one reader of vitest's `shuffle` suite option (#4561 D1).
 *
 * A `describe` whose subject IS the order its cases run in opts out with
 * `{ shuffle: false }` and is registered in `scripts/shuffle-census-ratchet.json`
 * (`byDesign`). The registry is only worth having if a reader sees EVERY
 * spelling of the option, so this module is an ALLOWLIST over the parsed AST:
 * it admits one opt-out spelling and one harmless opt-in, and reports
 * everything else it cannot read. The state table in PR #4611 is the contract
 * this file implements; the lettered rows below cite its cells.
 *
 * Review r2 (#4611): the r1 version read a fixed set of syntactic spellings off
 * `stripSource`'s text, so a shorthand property (`{ shuffle }`, whose value is
 * the binding) was invisible to both the key census and the "other options
 * beside" check and passed silently, and an aliased callee (`const d =
 * describe`) with a computed key passed too. The same text census read string
 * CONTENTS as code, so `const s = "{ shuffle: false }"` and a `{ shuffle:
 * boolean }` type red the gate. Structure now comes from `oxc-parser` (#4616:
 * an enumerated detector is replaced by one derived from the syntax tree): the
 * reader reads AST property nodes of object literals, so a string or a type
 * member is not a property and cannot be a finding.
 *
 * liveness (whether a run reaches the suite at all) stays owned by
 * `testDeclarations` in `sweep-kit.ts`, matched to the call by its opening
 * parenthesis: one owner answers "does vitest run this", and an opt-out this
 * reader cannot tie to a live, registered declaration refuses.
 */
import { parseSync, Visitor, type Node } from "oxc-parser";

import {
	lineOf,
	nextNonSpace,
	testDeclarations,
	type TestDeclaration,
} from "./sweep-kit.js";

export interface ShuffleOptOutFinding {
	/** 1-based line in the source the finding was read from. */
	line: number;
	message: string;
}

export interface ShuffleOptOutAudit {
	/** Titles of `describe`s that opt out with the admitted spelling, and run. */
	admitted: string[];
	findings: ShuffleOptOutFinding[];
}

/** Callees that declare a suite or a case. Only the suite pair is inspected. */
const TEST_CALLEES = new Set(["describe", "suite", "it", "test"]);
const SUITE_CALLEES = new Set(["describe", "suite"]);

/** A source range, so the net below can skip what the structural read judged. */
interface Span {
	start: number;
	end: number;
}

/** A property key, as far as this reader can name it (STATE_TABLE C rows). */
type KeyName =
	| { name: string; form: "bare" | "quoted" | "computed-literal" }
	| { name: undefined; form: "computed-unresolved" };

/** The resolved root of a callee chain, and whether a name in it was an alias. */
interface ResolvedCallee {
	root: string;
	aliased: boolean;
}

const REASON_SPREAD =
	"its options spread another object, so a shuffle opt-out carried in that object, and which object wins, is not readable here";
const REASON_COMPUTED =
	"its options hold a computed key whose name this reader cannot resolve, so an opt-out behind it is unattributable";
const REASON_SHORTHAND =
	"its shuffle property is written as a shorthand (`{ shuffle }`), so the value is the binding, not a literal this census can read";
const REASON_ACCESSOR =
	"its shuffle property is an accessor, not a value this census can read";
const REASON_UNREADABLE_VALUE =
	"the value of its shuffle property is not a literal true/false (it is read from a binding or a call), so whether it opts out is unattributable";
const REASON_UNSPELLED =
	"its shuffle key is spelled as a quoted or computed key; only the bare `shuffle` key is admitted";
const REASON_EXTRA_OPTIONS =
	"the shuffle opt-out is not the only property of its options object; an opt-out is admitted only as the minimal `{ shuffle: false }` marker, so the exemption stays visible";
const REASON_ALIASED =
	"it opts out of shuffle through a callee alias (`%callee%`), which this census cannot tie to a live, registered `describe`";
const REASON_NOT_LIVE =
	"opts out of shuffle but vitest never runs it (a skip or todo modifier, or an enclosing skipped suite), so its registry row would vouch for a suite the run does not include";
const REASON_OPTIONS_NOT_LITERAL =
	"its options are not a plain object literal in this file (an identifier bound elsewhere, a cast, a call, or a conditional), so a shuffle opt-out in them is unattributable";
const REASON_OUTSIDE =
	"a shuffle option key outside any describe options object: a shared options object, a helper, or a config is not attributable, so this census cannot tell which suite it opts out";

/** `node` as a plain field bag: oxc's `Node` union is narrower than its runtime shape. */
function fields(node: Node): Record<string, unknown> {
	return node as unknown as Record<string, unknown>;
}

/** A field that may hold one node or an array of them. */
function nodes(value: unknown): Node[] {
	const list = Array.isArray(value) ? value : [value];
	return list.filter(
		(child): child is Node =>
			child !== null && typeof child === "object" && "type" in child,
	);
}

/** The property key `property` declares, or `undefined` for a non-member. */
function keyName(property: Node): KeyName | undefined {
	if (property.type !== "Property") return undefined;
	const key = fields(property).key as Node | undefined;
	if (key === undefined) return undefined;
	if (fields(property).computed === true) {
		const value = fields(key).value;
		return typeof value === "string"
			? { name: value, form: "computed-literal" }
			: { name: undefined, form: "computed-unresolved" };
	}
	if (key.type === "Identifier")
		return { name: String(fields(key).name), form: "bare" };
	const value = fields(key).value;
	return typeof value === "string"
		? { name: value, form: "quoted" }
		: { name: undefined, form: "computed-unresolved" };
}

/** A literal `true`/`false`, or `undefined` when the value is computed. */
function booleanLiteral(node: Node | undefined): boolean | undefined {
	if (node === undefined || node.type !== "Literal") return undefined;
	const value = fields(node).value;
	return typeof value === "boolean" ? value : undefined;
}

/** The root callee name of a chain, with the alias names it passed through. */
function resolveCallee(
	callee: Node | undefined,
	aliases: ReadonlyMap<string, string>,
): ResolvedCallee | undefined {
	let current = callee;
	let aliased = false;
	for (let hops = 0; current !== undefined && hops < 64; hops++) {
		const record = fields(current);
		if (current.type === "Identifier") {
			const name = String(record.name);
			const target = aliases.get(name);
			if (target !== undefined) aliased = true;
			return { root: target ?? name, aliased };
		}
		if (current.type === "MemberExpression") {
			const object = record.object as Node | undefined;
			if (
				object?.type === "Identifier" &&
				aliases.has(String(fields(object).name))
			)
				aliased = true;
			current = object;
			continue;
		}
		if (current.type === "CallExpression") {
			current = record.callee as Node | undefined;
			continue;
		}
		return undefined;
	}
	return undefined;
}

/**
 * Local names bound to a test callee: `import { describe as X } from "vitest"`
 * and `const X = describe`. A call through one that no declaration answers for
 * refuses (STATE_TABLE C3/D2): a per-file read cannot prove the suite is live or
 * give its registry row a stable identity.
 */
function calleeAliases(bindings: readonly Node[]): Map<string, string> {
	const aliases = new Map<string, string>();
	const bind = (local: unknown, imported: unknown) => {
		if (typeof local !== "string" || typeof imported !== "string") return;
		// `import { describe } from "vitest"` binds the name to itself; only a
		// RENAME is an alias this reader has to resolve.
		if (local === imported) return;
		if (TEST_CALLEES.has(imported)) aliases.set(local, imported);
	};
	for (const node of bindings) {
		const record = fields(node);
		if (node.type === "ImportDeclaration") {
			const source = record.source as Node | undefined;
			if (source === undefined || fields(source).value !== "vitest") continue;
			for (const specifier of nodes(record.specifiers))
				if (specifier.type === "ImportSpecifier") {
					const specifierFields = fields(specifier);
					bind(
						fields(specifierFields.local as Node).name,
						fields(specifierFields.imported as Node).name,
					);
				}
			continue;
		}
		if (node.type === "VariableDeclarator") {
			const init = record.init as Node | undefined;
			const id = record.id as Node | undefined;
			if (init?.type !== "Identifier" || id?.type !== "Identifier") continue;
			bind(fields(id).name, fields(init).name);
		}
	}
	// Follow alias chains (`const a = describe; const b = a`).
	for (const [local, target] of [...aliases]) {
		let name = target;
		const seen = new Set([local]);
		while (aliases.has(name) && !seen.has(name)) {
			seen.add(name);
			name = aliases.get(name) as string;
		}
		aliases.set(local, name);
	}
	return aliases;
}

/** The `(` that opens a call, from its callee's last token. */
function callParen(
	source: string,
	callee: Node | undefined,
): number | undefined {
	if (callee === undefined) return undefined;
	const at = nextNonSpace(source, callee.end);
	return source[at] === "(" ? at : undefined;
}

/** Whether `span` lies inside any of `spans`. */
function inside(span: Span, spans: readonly Span[]): boolean {
	return spans.some(
		(outer) => span.start >= outer.start && span.end <= outer.end,
	);
}

/** What one file's audit accumulates while it walks the tree. */
interface Audit {
	source: string;
	aliases: ReadonlyMap<string, string>;
	/** Options objects the structural read judged; the net adds nothing there. */
	inspected: Span[];
	admitted: string[];
	findings: ShuffleOptOutFinding[];
	report(at: number, message: string): void;
	/** liveness for the call opening at `paren`, from the shared owner. */
	declarationOf(paren: number | undefined): TestDeclaration | undefined;
}

/**
 * One `describe`/`suite` call (STATE_TABLE A/B/C/D rows): admit its opt-out, or
 * report why the options object is not readable. Returns nothing; a call
 * outside the suite pair is the net's business.
 */
function judgeSuiteCall(node: Node, audit: Audit): void {
	const record = fields(node);
	const callee = record.callee as Node | undefined;
	const resolved = resolveCallee(callee, audit.aliases);
	if (resolved === undefined || !SUITE_CALLEES.has(resolved.root)) return;
	const args = nodes(record.arguments);
	// B1/B2: no options slot. A body passed by name is silent; an object
	// literal in the body slot is judged by the net.
	if (args.length < 3) return;
	const options = args[1] as Node;
	audit.inspected.push({ start: options.start, end: options.end });

	if (options.type !== "ObjectExpression") {
		audit.report(
			options.start,
			`describe options: ${REASON_OPTIONS_NOT_LITERAL}`,
		); // B4
		return;
	}

	const properties = nodes(fields(options).properties);
	let optedOut: number | undefined;
	let problem: string | undefined;
	for (const property of properties) {
		if (property.type === "SpreadElement") {
			problem ??= REASON_SPREAD; // P8
			continue;
		}
		const key = keyName(property);
		if (key === undefined) continue;
		if (key.form === "computed-unresolved") {
			problem ??= REASON_COMPUTED; // P7
			continue;
		}
		if (key.name !== "shuffle") continue; // P11
		const propertyFields = fields(property);
		if (propertyFields.kind !== "init") {
			problem ??= REASON_ACCESSOR; // P10
			continue;
		}
		if (propertyFields.shorthand === true) {
			problem ??= REASON_SHORTHAND; // P4
			continue;
		}
		const value = booleanLiteral(propertyFields.value as Node | undefined);
		if (value === undefined) {
			problem ??= REASON_UNREADABLE_VALUE; // P3
			continue;
		}
		if (value) continue; // P2: a readable opt-in, no row needed
		if (key.form !== "bare") {
			problem ??= REASON_UNSPELLED; // P5, P6
			continue;
		}
		optedOut ??= property.start;
	}

	const declaration = () =>
		audit.declarationOf(callParen(audit.source, callee));

	if (problem !== undefined) {
		audit.report(
			options.start,
			`describe "${declaration()?.title ?? "?"}": ${problem}`,
		);
		return;
	}
	if (optedOut === undefined) return;
	const owner = declaration();
	const title = owner?.title ?? "?";
	if (properties.length > 1) {
		audit.report(optedOut, `describe "${title}": ${REASON_EXTRA_OPTIONS}`); // P9
		return;
	}
	if (owner === undefined) {
		audit.report(
			options.start,
			`describe "${title}": ${REASON_ALIASED.replace("%callee%", resolved.root)}`,
		); // D2
		return;
	}
	if (!owner.live) {
		audit.report(options.start, `describe "${title}": ${REASON_NOT_LIVE}`); // D1
		return;
	}
	audit.admitted.push(title);
}

/**
 * Every `describe` opt-out the caller sets, and every `shuffle` key this reader
 * cannot attribute. Pass the file's raw source, and its path when the extension
 * decides the grammar (`.ts`/`.tsx`/`.js`).
 */
export function auditShuffleOptOuts(
	source: string,
	file = "source.ts",
): ShuffleOptOutAudit {
	const admitted: string[] = [];
	const findings: ShuffleOptOutFinding[] = [];
	const parsed = parseSync(file, source);
	const firstError = parsed.errors[0];
	if (firstError !== undefined) {
		// H1: a file this reader cannot parse must never pass.
		findings.push({
			line: lineOf(source, firstError.labels[0]?.start ?? 0),
			message: `this file does not parse (${firstError.message}), so no shuffle opt-out in it is attributable`,
		});
		return { admitted, findings };
	}

	// liveness is the expensive read (it re-blanks the file inside
	// `testDeclarations`), so it is resolved lazily: the census sweeps every
	// tracked test file, and almost none of them name the option at all.
	let declarations: Map<number, TestDeclaration> | undefined;
	const audit: Audit = {
		source,
		aliases: new Map(),
		inspected: [],
		admitted,
		findings,
		report: (at, message) =>
			findings.push({ line: lineOf(source, at), message }),
		declarationOf: (paren) => {
			if (paren === undefined) return undefined;
			declarations ??= new Map(
				testDeclarations(source).map((declaration) => [
					declaration.callParen,
					declaration,
				]),
			);
			return declarations.get(paren);
		},
	};

	const bindings: Node[] = [];
	const calls: Node[] = [];
	const literals: Node[] = [];
	new Visitor({
		ImportDeclaration: (node) => bindings.push(node),
		VariableDeclarator: (node) => bindings.push(node),
		CallExpression: (node) => calls.push(node),
		ObjectExpression: (node) => literals.push(node),
	}).visit(parsed.program);
	audit.aliases = calleeAliases(bindings);

	for (const call of calls) judgeSuiteCall(call, audit);

	// F1: the net. An object literal that names a `shuffle` key and is not an
	// options slot the structural read judged is not attributable to a suite, so
	// it reds instead of passing unclassified.
	for (const literal of literals) {
		const span: Span = { start: literal.start, end: literal.end };
		if (inside(span, audit.inspected)) continue;
		for (const property of nodes(fields(literal).properties)) {
			if (keyName(property)?.name !== "shuffle") continue;
			// P2: a readable opt-in needs no row, here as at a describe.
			if (booleanLiteral(fields(property).value as Node | undefined) === true)
				break;
			audit.report(property.start, REASON_OUTSIDE);
			break;
		}
	}

	return { admitted, findings };
}

export interface ShuffleOptOutCensus {
	/** `${file}::${describe}` for every admitted, registered-shaped opt-out. */
	optedOut: Set<string>;
	/** `${file}:${line}: ${message}`, in the order the files were read. */
	findings: string[];
}

/**
 * The census over a set of sources, as the gate reads it: one entry per file,
 * the admitted opt-outs keyed by file, and every finding flattened with its
 * location. `tests/scripts/ci-shuffle-census.test.ts` runs it over the tracked
 * tests tree, and over the planted fixtures that prove each rejected spelling
 * reds (#4611 review r1 M2, M3; r2 M-a, M-b).
 */
export function censusShuffleOptOuts(
	entries: Iterable<{ file: string; source: string }>,
): ShuffleOptOutCensus {
	const optedOut = new Set<string>();
	const findings: string[] = [];
	for (const { file, source } of entries) {
		const audit = auditShuffleOptOuts(source, file);
		for (const title of audit.admitted) optedOut.add(`${file}::${title}`);
		for (const finding of audit.findings)
			findings.push(`${file}:${finding.line}: ${finding.message}`);
	}
	return { optedOut, findings };
}

/**
 * The gate's verdict over a census and the registry's rows: every issue the
 * population raises, in one list, so the tree sweep and the planted spellings
 * assert the same thing. Empty means every opt-out in the population is the
 * admitted spelling, registered, and matched by a row that still names a live
 * describe.
 */
export function judgeShuffleOptOuts(
	census: ShuffleOptOutCensus,
	registered: Iterable<string>,
): string[] {
	const rows = new Set(registered);
	const issues = [...census.findings];
	for (const key of census.optedOut) {
		if (!rows.has(key))
			issues.push(`${key}: opts out of shuffle but is not registered`);
	}
	for (const key of rows) {
		if (!census.optedOut.has(key))
			issues.push(
				`${key}: registered, but no live describe in that file opts out`,
			);
	}
	return issues;
}
