/**
 * #4590 — env composition lint for the platform `PATH` key.
 *
 * Windows' environment block is CASE-INSENSITIVE, while a Node
 * `NodeJS.ProcessEnv` object is not. So an env object that writes the path
 * variable under two spellings (`PATH` and `Path`) hands the child two names
 * for one variable, and one of them shadows the other in the block the child
 * actually receives. Writing only `PATH` over a base that already carries
 * `Path` (`{ ...process.env, PATH: next }`) has the same effect, because the
 * spread is what supplied the other spelling.
 *
 * The shape has already redded a release lane: #4566 round 9 (Greptile
 * `4302492421`, "Child lookups use wrong PATH") found a trust-scoped env that
 * READ `Path` and WROTE `PATH`, and the round-10 fix
 * (`a82a09699`) replaced the dual-spelling literals with one setter that picks
 * the key per platform. The round-14 threads the issue names
 * (`4303887682`, `4304149666`) are the same PR's launcher cells failing on
 * Windows. The literal the round-10 fix removed is still on master today
 * (`clients/lsp/launch.ts:783`), which is why this sweep ships with a seeded
 * baseline rather than a clean tree; #4566 deletes it, and that PR must delete
 * the two `launchLSP` rows below with it (whichever of the two lands second).
 *
 * ## The rule
 *
 * One sanctioned composition: a FRESH object literal that writes the path
 * variable under exactly one spelling, with nothing inherited into it. Every
 * other write is a finding, with the reason it is one:
 *
 * - `dual-spelling` — the composition writes both spellings. That is the
 *   defect itself, and it is also why the "cover both spellings" idiom loses:
 *   the second write is what shadows the first.
 * - `spread-override` — the composition writes one spelling over an inherited
 *   base (`{ ...base, PATH: next }`, `Object.assign({}, process.env, { PATH })`,
 *   `Object.fromEntries([...Object.entries(process.env), ["PATH", v]])`). The
 *   base is what supplied the other spelling on Windows, so the composition
 *   still carries two names.
 * - `live-process-env` — a `process.env.PATH = …` write, or
 *   `Object.assign(process.env, { PATH })`. `process.env` is the base of every
 *   child env, so the write has the same inheritance problem and reaches the
 *   HOST process besides.
 * - `unclassified-spelling` — a write this sweep cannot place: a member write
 *   on a base whose contents it cannot see (`env["PATH"] = …` on a parameter,
 *   `Object.assign(env, { PATH })`), a mixed-case spelling of the variable that
 *   is not one of the two spellings the tree actually uses (`env.PaTh = …`), a
 *   lone lowercase `path` in an env-identified composition, or a computed key
 *   naming the variable that does not resolve. This is the fail-closed arm: an
 *   env-key write the classifier cannot place is a finding, never a silent
 *   pass (AGENTS.md shape 69).
 *
 * ## The composer exists; these call sites do not use it
 *
 * `mergeWindowsEnvironment` (`clients/safe-spawn.ts`) is the shared composer
 * this rule points at: it folds every ambient spelling into one key and lets
 * explicit overrides win. `getSpawnEnvironment` applies it on win32, so a
 * `safeSpawnAsync` consumer already collapses its env and owes nothing. A
 * consumer that spawns through `nodeSpawn` with its own `env` bypasses that
 * step — `clients/lsp/launch.ts` (reached from the installer's
 * `getToolEnvironment` and from `python-environment`'s pyright launch) is the
 * row this affects. A fix therefore differs per site: a `safeSpawnAsync`
 * consumer needs nothing, a direct-spawn consumer needs the merge applied
 * before the spawn. This lane adds the detector and seeds the current
 * non-fresh compositions in {@link SEEDED_OFFENDERS} as debt; when a site
 * adopts the composer its row goes stale, which this test reds on.
 *
 * ## Why a syntax tree, not a text scan
 *
 * Rounds 1 and 2 of this detector were regexes over comment/string-blanked
 * text, and a review broke it four ways in one sitting (#4600):
 *
 * - `Object.assign({}, process.env, { PATH })` and
 *   `Object.fromEntries([...Object.entries(process.env), ["PATH", v]])` were
 *   invisible: neither shape is an object literal with a key in it, so the
 *   literal arm recorded nothing and the census stayed green with two
 *   offenders planted;
 * - a quoted or computed key that started on its own line escaped, because the
 *   key patterns allowed no newline after the `{`/`,` — `oxfmt` formats a
 *   multi-member literal exactly that way, so the verdict depended on layout;
 * - any `...` anywhere in the literal body marked it as inheriting a base, so
 *   the sanctioned `{ PATH: path.join(...segments) }` was reported;
 * - writes were grouped by BINDING NAME, so two functions that each declare
 *   `const env` merged into one false dual spelling.
 *
 * All four are the same mistake in different spellings (AGENTS.md shapes 34
 * and 69): a text pattern stands in for a structural fact. A parser answers
 * the four questions that actually decide the verdict — which object literal
 * holds the key, whether that literal spreads a base, which object the write
 * lands on, and how a binding resolves — so the patterns are gone. `stripSource`
 * is gone with them: a key inside a comment or a string is not an object key,
 * so no blanker is needed to tell them apart.
 *
 * ## SWEEP_HEURISTIC_LIMITS
 *
 * 1. A lone `path:` (all-lowercase) key write is NOT flagged unless the
 *    composition is identifiable as an env. It is indistinguishable from the
 *    `{ path: … }` DATA key that appears throughout the tree (telemetry
 *    records, route descriptors, tool payloads), and flagging that population
 *    would bury the signal — measured 61 `X.path = …` member writes in the
 *    scanned trees. A lowercase `path` write is still counted as a PARTICIPANT
 *    when the same composition also writes `PATH` or `Path`, so a
 *    three-spelling composition is still one finding. A MIXED-case spelling
 *    (`PaTh`, `pATH`) has no such collision (measured 0 in the scanned trees),
 *    so it fails closed without requiring env identification.
 * 2. The fail-closed arm for a computed key needs an env-identified
 *    composition: a literal bound with a `ProcessEnv` annotation, a literal in
 *    an `env:` position, a literal spreading `process.env`, or a member write
 *    on `process.env` or a `ProcessEnv`-typed binding. A path-naming expression
 *    in an object this sweep cannot identify as an env is not flagged, because
 *    "this key is an env PATH" is exactly what it cannot see. An env assembled
 *    by a helper in another module is out of the population for the same
 *    reason.
 * 3. A key computed at run time from a value this file does not hold
 *    (`env[await pathKey()] = …`) is not resolved; it reaches the fail-closed
 *    arm instead. A literal-const alias (`const KEY = "PATH"; env[KEY] = …`)
 *    IS resolved, because it is one binding away and costs nothing.
 * 4. The READ side is out of scope. `base.PATH ?? base.Path` and
 *    `Path`-before-`PATH` read order are the round-9 defect's shape, but a read
 *    chain is legal in both orders and this sweep does not have a verdict to
 *    offer. Reads are grepped by the reviewer, not censused here.
 * 5. A single-spelling `process.env.PATH = …` in a `tests/**` file is a harness
 *    PATH stub (set, exercise, restore), not a shipped composition, and the
 *    sweep does not census it: measured at authoring time, 92 of the tree's 94
 *    live-env writes are that stub, and a ratchet that reds on every new PATH
 *    stub would be reverted before it caught anything. Both spellings in one
 *    stub, and every literal composition, stay in scope there — the two
 *    shipped live-env writes (`clients/lsp/server.ts`, a smoke script) stay in
 *    scope too. The remedy is the same composer the production rows wait on;
 *    when they adopt it this limit can be deleted.
 * 6. A path-key TUPLE outside `Object.fromEntries` (`new Map([["PATH", v]])`,
 *    a plain array of entries handed to a helper) is not censused: the tuple is
 *    a data shape until the call that consumes it says otherwise, and only
 *    `fromEntries` / `assign` are recognized here.
 *
 * ## The walk and its admission filter
 *
 * Scanned trees are `clients/`, `scripts/`, `tests/` and `index.ts` (the
 * population is ~2,350 files, of which ~445 can contain a path key). Parsing
 * every walked file cost 2.2 s on the authoring box and timed this case out at
 * its 5 s default on the Windows lane (#4600 F3), so a file is parsed only
 * when its RAW text carries a path-folded key SHAPE
 * ({@link PATH_KEY_SHAPE}). The filter runs on raw text, so a comment or a
 * string can only ADMIT a file — never hide one — and it is a superset of
 * every key position this detector reads: literal key, shorthand, member,
 * subscript, computed key, and a `fromEntries` tuple. The admitted population
 * is asserted against a floor, so a filter that stops matching reds instead of
 * quietly shrinking the census.
 *
 * The seeded baseline below is the debt at authoring time — shipped
 * `clients/` and `scripts/` code (every non-fresh composer in the tree:
 * `runner-helpers`, the installer's two envs, `lsp/launch`, `lsp/server`,
 * `python-environment`, the guard probe, a smoke script) and test fixtures that
 * spawn a child with an augmented PATH. A row is keyed
 * `file#declaration:lineHash#spelling` through the kit's own
 * `stableOccurrenceKey`, so the same spelling in another declaration, and a
 * rewritten line, are both new rows; two byte-identical flagged lines inside one
 * declaration (a stub that sets and restores the same env write) share that
 * content key and are disambiguated by `~n`, their order of appearance in the
 * file. `~n` is deliberately not a byte offset: an offset re-keys on an
 * unrelated insertion above, which is #2487's laundering shape, while the
 * ordinal of an identical line does not move.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stableOccurrenceKey,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** Why one env write is not the sanctioned fresh single-spelling literal. */
export type PathKeyReason =
	| "dual-spelling"
	| "spread-override"
	| "live-process-env"
	| "unclassified-spelling";

export interface PathKeyFinding {
	/** 1-based line of the key or property that writes the path variable. */
	line: number;
	/** The exact spelling written (`PATH`, `Path`, …). */
	spelling: string;
	reason: PathKeyReason;
	/** The composition the write belongs to, for a message that reads. */
	site: string;
}

/**
 * How the written key names the variable. A canonical spelling is the
 * sanctioned form; a lowercase one is a data key as often as an env key
 * (limit 1); a mixed-case one is neither (limit 1, fail closed); an expression
 * only NAMES the variable (limit 2/3, fail closed when the composition is an
 * env).
 */
type SpellingShape = "canonical" | "lowercase" | "case-variant" | "expression";

/** One write of the path variable into an env object. */
interface RawWrite {
	line: number;
	spelling: string;
	shape: SpellingShape;
	kind: "literal" | "member";
	/** Composition identity: the binding declaration or the literal itself. */
	group: string;
	site: string;
	/** The composition spreads (or copies) a base it does not own. */
	inheritsBase: boolean;
	/** The composition is identifiable as an env (see limit 2). */
	envIdentified: boolean;
	/** The write lands on `process.env` itself. */
	live: boolean;
}

/** One path-folded key found in a key position. */
interface KeyRef {
	spelling: string;
	shape: SpellingShape;
	/** 1-based line of the key token. */
	line: number;
}

const FUNCTION_KINDS = new Set([
	"function_declaration",
	"function_expression",
	"generator_function",
	"generator_function_declaration",
	"arrow_function",
	"method_definition",
]);

const SCOPE_KINDS = new Set([...FUNCTION_KINDS, "program", "statement_block"]);

/** A binding owner that is not a scope: the unresolved-base fallback. */
const OWNER_KINDS = new Set([...FUNCTION_KINDS, "program"]);

/** One spelling of the variable, as a Rust regex over a key node's text. */
const PATH_SPELLING = "^[Pp][Aa][Tt][Hh]$";

/** A quoted spelling of the variable, quotes included. */
const PATH_STRING_KEY = "^[\"'`][Pp][Aa][Tt][Hh][\"'`]$";

const PARAMETER_KINDS = new Set(["required_parameter", "optional_parameter"]);

/** A case-insensitive match for the variable name itself. */
function foldsToPath(text: string): boolean {
	return text.toLowerCase() === "path";
}

/** The two spellings a Windows env block actually carries. */
function isCanonicalSpelling(text: string): boolean {
	return text === "PATH" || text === "Path";
}

/** Classify a key TEXT that is a spelling of the variable. */
function shapeOfSpelling(text: string): SpellingShape {
	if (isCanonicalSpelling(text)) return "canonical";
	return text === "path" ? "lowercase" : "case-variant";
}

/** `"PATH"` → `PATH`; other text unchanged. */
function unquote(text: string): string {
	const first = text[0];
	if (
		(first === '"' || first === "'" || first === "`") &&
		text.length >= 2 &&
		text.endsWith(first)
	) {
		return text.slice(1, -1);
	}
	return text;
}

/** The named children of a node, memoised for one scan. */
function childrenOf(node: SgNode): SgNode[] {
	return node.namedChildren();
}

function firstOfKind(node: SgNode, kind: string): SgNode | undefined {
	return childrenOf(node).find((child) => child.kind() === kind);
}

/** `ProcessEnv` in a type annotation, `Partial<ProcessEnv>` included. */
function annotatedAsEnv(node: SgNode | undefined): boolean {
	if (node === undefined) return false;
	const annotation = firstOfKind(node, "type_annotation");
	return annotation !== undefined && /ProcessEnv/.test(annotation.text());
}

// ── binding resolution ──────────────────────────────────────────────────

interface Declaration {
	name: string;
	/** Byte offset of the declared name — the composition identity. */
	index: number;
	/** The name is declared as a `ProcessEnv` (annotation on the declarator). */
	envTyped: boolean;
}

interface ScanContext {
	/** `const KEY = "Path"` → `{ KEY: "Path" }`, built on first use. */
	aliases(): ReadonlyMap<string, string>;
	/** The declaration a name at `reference` resolves to, if this file has one. */
	resolve(reference: SgNode, name: string): Declaration | undefined;
	/** Offset of the nearest enclosing function, for an unresolved base. */
	ownerStart(reference: SgNode): number;
}

/**
 * Resolve a name to its nearest preceding declaration in the enclosing scope
 * chain. Lexical, one file, no type resolution: a `var` hoisted from a nested
 * block, a destructured name and a re-exported binding all fall through to
 * `undefined`, which the caller reports as an opaque base instead of guessing.
 *
 * The table is built on FIRST USE: 444 of the walked files are admitted to the
 * parser and most of them never resolve a name, so an eager pass over every
 * declarator would be the census's whole cost (#4600 F3).
 */
function buildContext(root: SgNode): ScanContext {
	let tables:
		| {
				aliases: ReadonlyMap<string, string>;
				byScope: ReadonlyMap<number, ReadonlyMap<string, Declaration[]>>;
		  }
		| undefined;

	const load = (): typeof tables & object => {
		const aliases = new Map<string, string>();
		const byScope = new Map<number, Map<string, Declaration[]>>();

		const declare = (
			name: string,
			named: SgNode,
			owner: SgNode,
			envTyped: boolean,
		): void => {
			const scope =
				nearestIn(chainOf(owner), SCOPE_KINDS)?.range().start.index ?? 0;
			const scoped = byScope.get(scope) ?? new Map<string, Declaration[]>();
			const list = scoped.get(name) ?? [];
			list.push({ name, index: named.range().start.index, envTyped });
			scoped.set(name, list);
			byScope.set(scope, scoped);
		};

		for (const declarator of root.findAll({
			rule: { kind: "variable_declarator" },
		})) {
			const nameNode = firstOfKind(declarator, "identifier");
			if (nameNode === undefined) continue;
			const name = nameNode.text();
			const value = declarator
				.namedChildren()
				.filter(
					(child) =>
						child.kind() !== "identifier" && child.kind() !== "type_annotation",
				)
				.at(-1);
			if (value !== undefined && value.kind() === "string") {
				const literal = unquote(value.text());
				if (foldsToPath(literal)) aliases.set(name, literal);
			}
			declare(name, nameNode, declarator, annotatedAsEnv(declarator));
		}
		for (const kind of PARAMETER_KINDS) {
			for (const parameter of root.findAll({ rule: { kind } })) {
				const nameNode = firstOfKind(parameter, "identifier");
				if (nameNode === undefined) continue;
				declare(
					nameNode.text(),
					nameNode,
					parameter,
					annotatedAsEnv(parameter),
				);
			}
		}
		return { aliases, byScope };
	};

	return {
		aliases: () => (tables ??= load()).aliases,
		resolve: (reference, name) => {
			const { byScope } = (tables ??= load());
			const at = reference.range().start.index;
			for (const ancestor of chainOf(reference)) {
				if (!SCOPE_KINDS.has(kindName(ancestor))) continue;
				const list = byScope.get(ancestor.range().start.index)?.get(name);
				let chosen: Declaration | undefined;
				for (const entry of list ?? []) {
					if (entry.index <= at) chosen = entry;
				}
				if (chosen !== undefined) return chosen;
			}
			return undefined;
		},
		ownerStart: (reference) => {
			const owner = nearestIn(chainOf(reference), OWNER_KINDS);
			return owner === undefined ? 0 : owner.range().start.index;
		},
	};
}

// ── key extraction ──────────────────────────────────────────────────────

/**
 * The path-folded key `node` writes, if it writes one.
 *
 * `pair` keys, shorthand entries and `fromEntries` tuple heads all reach here.
 * A string key's text is unquoted; a computed key is resolved through a
 * literal-const alias, and otherwise fails closed only when it NAMES the
 * variable (limit 2/3).
 */
function literalKeyRef(
	node: SgNode,
	aliases: ReadonlyMap<string, string>,
): KeyRef | undefined {
	const line = node.range().start.line + 1;
	switch (node.kind()) {
		case "property_identifier":
		case "shorthand_property_identifier": {
			const text = node.text();
			if (!foldsToPath(text)) return undefined;
			return { spelling: text, shape: shapeOfSpelling(text), line };
		}
		case "string": {
			const text = unquote(node.text());
			if (!foldsToPath(text)) return undefined;
			return { spelling: text, shape: shapeOfSpelling(text), line };
		}
		case "computed_property_name": {
			const inner = childrenOf(node)[0];
			return inner === undefined ? undefined : expressionKeyRef(inner, aliases);
		}
		default:
			return undefined;
	}
}

/** A computed or subscript key: an alias, a string, or a path-naming expression. */
function expressionKeyRef(
	node: SgNode,
	aliases: ReadonlyMap<string, string>,
): KeyRef | undefined {
	const line = node.range().start.line + 1;
	const kind = kindName(node);
	if (kind === "identifier") {
		const alias = aliases.get(node.text());
		if (alias !== undefined) {
			return { spelling: alias, shape: shapeOfSpelling(alias), line };
		}
	} else if (kind === "string") {
		const text = unquote(node.text());
		if (foldsToPath(text)) {
			return { spelling: text, shape: shapeOfSpelling(text), line };
		}
	}
	const text = kind === "string" ? unquote(node.text()) : node.text();
	if (!/path/i.test(text)) return undefined;
	return { spelling: text, shape: "expression", line };
}

// ── composition context ─────────────────────────────────────────────────

interface Composition {
	group: string;
	site: string;
	inheritsBase: boolean;
	envIdentified: boolean;
	live: boolean;
	kind: "literal" | "member";
}

/**
 * A node's ancestors, nearest first. Each `parent()` call crosses into the
 * addon, so a walk that asks five questions about one node takes ONE chain, not
 * five climbs: the census parses ~15 MB of source and the per-node walks were
 * most of its cost (#4600 F3).
 */
type Chain = readonly SgNode[];

function chainOf(node: SgNode): Chain {
	return node.ancestors();
}

/** The node kind as a string (`kind()` is typed as the whole Kinds union). */
function kindName(node: SgNode): string {
	return String(node.kind());
}

function nearestIn(
	chain: Chain,
	kinds: ReadonlySet<string>,
): SgNode | undefined {
	return chain.find((node) => kinds.has(kindName(node)));
}

function isProcessEnvNode(node: SgNode | undefined): boolean {
	if (node === undefined) return false;
	return /^process\s*\.\s*env$/.test(node.text().replace(/\s+/g, ""));
}

function isFreshObjectLiteral(node: SgNode | undefined): boolean {
	if (node === undefined || node.kind() !== "object") return false;
	return !childrenOf(node).some((child) => child.kind() === "spread_element");
}

/**
 * The object literal at the top of a spread chain: `...(cond ? { Path } : {})`
 * composes INTO the literal that holds the spread, so both belong to one
 * composition (limit: only a spread in MEMBER position climbs; a `...rest`
 * argument inside a value does not, see limit 6 and the F5 case).
 */
const SPREAD_CLIMB = new Set([
	"parenthesized_expression",
	"ternary_expression",
	"binary_expression",
	"spread_element",
]);

function rootLiteralOf(literal: SgNode): SgNode {
	let cursor = literal;
	for (let step = 0; step < 12; step++) {
		const parent = cursor.parent();
		if (parent === null) break;
		const kind = kindName(parent);
		// A spread chain climbs: `...(cond ? { Path } : {})` joins the literal
		// that holds the spread. Anything else (a `...rest` argument inside a
		// VALUE, a call, a pair) stops the climb, which is #4600 F5.
		if (kind === "object" && cursor.kind() !== "spread_element") break;
		if (SPREAD_CLIMB.has(kind) || kind === "object") {
			cursor = parent;
			continue;
		}
		break;
	}
	return cursor.kind() === "object" ? cursor : literal;
}

/** `as`/`satisfies`/parenthesized wrappers between an expression and its holder. */
const WRAPPER_KINDS = new Set([
	"as_expression",
	"satisfies_expression",
	"parenthesized_expression",
	"type_assertion",
]);

function unwrapExpression(node: SgNode): SgNode {
	let cursor = node;
	for (let step = 0; step < 4; step++) {
		const parent = cursor.parent();
		if (parent === null || !WRAPPER_KINDS.has(kindName(parent))) return cursor;
		cursor = parent;
	}
	return cursor;
}

/** The group a write on `base` belongs to. */
function groupForBase(base: SgNode, context: ScanContext): string {
	if (isProcessEnvNode(base)) return "process.env";
	if (base.kind() === "identifier") {
		const declaration = context.resolve(base, base.text());
		if (declaration !== undefined) return `decl@${declaration.index}`;
	}
	const text = base.text().replace(/\s+/g, "");
	return `bind:${text}@${context.ownerStart(base)}`;
}

function baseIsEnv(base: SgNode, context: ScanContext): boolean {
	if (isProcessEnvNode(base)) return true;
	if (base.kind() !== "identifier") return false;
	return context.resolve(base, base.text())?.envTyped === true;
}

/** Does the literal itself (or the position it sits in) say "this is an env"? */
function literalIsEnv(literal: SgNode, context: ScanContext): boolean {
	const spreads = childrenOf(literal).filter(
		(child) => child.kind() === "spread_element",
	);
	if (
		spreads.some((spread) => /^\s*process\s*\.\s*env\b/.test(spread.text()))
	) {
		return true;
	}

	let cursor: SgNode = literal;
	for (let step = 0; step < 12; step++) {
		const parent = cursor.parent();
		if (parent === null) return false;
		const kind = kindName(parent);
		if (
			kind === "as_expression" ||
			kind === "satisfies_expression" ||
			kind === "type_assertion"
		) {
			if (/ProcessEnv/.test(parent.text())) return true;
			cursor = parent;
			continue;
		}
		if (kind === "parenthesized_expression" || kind === "ternary_expression") {
			cursor = parent;
			continue;
		}
		if (kind === "pair") {
			const key = childrenOf(parent)[0];
			return key !== undefined && key.text() === "env";
		}
		if (kind === "variable_declarator") {
			return annotatedAsEnv(parent);
		}
		if (kind === "return_statement") {
			// The literal is a function's return value: the function's own
			// `ProcessEnv` return type is what identifies it (and its body block
			// never counts as a literal — that is why this asks the parser for the
			// function, not for the nearest brace).
			let owner: SgNode | null = parent;
			while (owner !== null && !FUNCTION_KINDS.has(kindName(owner))) {
				owner = owner.parent();
			}
			return (
				owner !== null &&
				/ProcessEnv/.test(firstOfKind(owner, "type_annotation")?.text() ?? "")
			);
		}
		if (kind === "arguments") {
			return argumentIsEnv(parent, context);
		}
		return false;
	}
	return false;
}

/** A literal handed to `Object.assign`/`Object.fromEntries` with an env in the chain. */
function argumentIsEnv(args: SgNode, context: ScanContext): boolean {
	const call = args.parent();
	if (call === null) return false;
	const name = calleeName(call);
	if (name !== "assign" && name !== "fromEntries") return false;
	return childrenOf(args).some(
		(argument) =>
			isProcessEnvNode(argument) ||
			(argument.kind() === "identifier" && baseIsEnv(argument, context)),
	);
}

/** `Object.assign` → `assign`; anything else → its own text. */
function calleeName(call: SgNode): string | undefined {
	const callee = childrenOf(call)[0];
	return callee?.kind() === "member_expression"
		? childrenOf(callee).at(-1)?.text()
		: callee?.text();
}

function isObjectCall(call: SgNode, method: string): boolean {
	const callee = childrenOf(call)[0];
	if (callee === undefined || callee.kind() !== "member_expression")
		return false;
	const target = childrenOf(callee)[0];
	return (
		target?.text() === "Object" && childrenOf(callee).at(-1)?.text() === method
	);
}

/** The composition a path-folded key inside `literal` belongs to. */
function compositionOf(literal: SgNode, context: ScanContext): Composition {
	const root = rootLiteralOf(literal);
	const composition: Composition = {
		group: `lit@${root.range().start.index}`,
		site: `literal@${root.range().start.index}`,
		inheritsBase: childrenOf(root).some(
			(child) => child.kind() === "spread_element",
		),
		envIdentified: literalIsEnv(root, context),
		live: false,
		kind: "literal",
	};

	const parent = unwrapExpression(root).parent();
	if (parent === null) return composition;

	if (parent.kind() === "variable_declarator") {
		const name = firstOfKind(parent, "identifier");
		if (name !== undefined) {
			composition.group = `decl@${name.range().start.index}`;
			composition.site = `bind:${name.text()}`;
		}
		return composition;
	}

	if (parent.kind() === "arguments") {
		const call = parent.parent();
		if (call === null) return composition;
		const args = childrenOf(parent);
		if (isObjectCall(call, "assign") && args.length >= 2) {
			const [target, ...sources] = args;
			if (isProcessEnvNode(target)) {
				composition.group = "process.env";
				composition.site = "process.env";
				composition.live = true;
				return composition;
			}
			if (target !== undefined && isFreshObjectLiteral(target)) {
				// A fresh target keeps the group at the call: every source literal
				// composes into the same new object.
				composition.group = `assign@${call.range().start.index}`;
				composition.site = `Object.assign@${call.range().start.line + 1}`;
				composition.inheritsBase =
					composition.inheritsBase ||
					sources.some(
						(source) => source !== root && !isFreshObjectLiteral(source),
					);
				return composition;
			}
			if (target !== undefined) {
				// `Object.assign(env, { PATH })` writes into an object this file may
				// not own: the same verdict a member write gets.
				composition.group = groupForBase(target, context);
				composition.site = `bind:${target.text().replace(/\s+/g, "")}`;
				composition.kind = "member";
				composition.envIdentified =
					composition.envIdentified || baseIsEnv(target, context);
				return composition;
			}
		}
	}
	return composition;
}

// ── collection ──────────────────────────────────────────────────────────

/**
 * Record the write one object-literal key makes. `node` is a `pair` or a
 * `shorthand_property_identifier` the AST query already admitted; the literal
 * it belongs to is its nearest enclosing `object`.
 */
function collectKeyNode(
	node: SgNode,
	context: ScanContext,
	out: RawWrite[],
): void {
	const keyNode = node.kind() === "pair" ? childrenOf(node)[0] : node;
	if (keyNode === undefined) return;
	const key = literalKeyRef(keyNode, context.aliases());
	if (key === undefined) return;
	let literal: SgNode | null = node;
	while (literal !== null && literal.kind() !== "object") {
		literal = literal.parent();
	}
	if (literal === null || literal.kind() !== "object") return;
	const composition = compositionOf(literal, context);
	out.push({
		line: key.line,
		spelling: key.spelling,
		shape: key.shape,
		kind: composition.kind,
		group: composition.group,
		site: composition.site,
		inheritsBase: composition.inheritsBase,
		envIdentified: composition.envIdentified,
		live: composition.live,
	});
}

function collectMemberWrite(
	node: SgNode,
	context: ScanContext,
	out: RawWrite[],
): void {
	const left = childrenOf(node)[0];
	if (left === undefined) return;
	let base: SgNode | undefined;
	let ref: KeyRef | undefined;
	if (left.kind() === "member_expression") {
		base = childrenOf(left)[0];
		const property = childrenOf(left).at(-1);
		ref =
			property === undefined
				? undefined
				: literalKeyRef(property, context.aliases());
	} else if (left.kind() === "subscript_expression") {
		base = childrenOf(left)[0];
		const index = childrenOf(left)[1];
		ref =
			index === undefined
				? undefined
				: expressionKeyRef(index, context.aliases());
	}
	if (base === undefined || ref === undefined) return;
	const baseText = base.text().replace(/\s+/g, "");
	out.push({
		line: ref.line,
		spelling: ref.spelling,
		shape: ref.shape,
		kind: "member",
		group: groupForBase(base, context),
		site: `bind:${baseText}`,
		inheritsBase: false,
		envIdentified: baseIsEnv(base, context),
		live: isProcessEnvNode(base),
	});
}

/**
 * `Object.fromEntries([…, ["PATH", value]])` — an env built one entry at a
 * time. The tuple's first element is a key in every way that matters here.
 */
function collectFromEntries(
	node: SgNode,
	context: ScanContext,
	out: RawWrite[],
): void {
	if (!isObjectCall(node, "fromEntries")) return;
	const args = firstOfKind(node, "arguments");
	const entries = args === undefined ? undefined : childrenOf(args)[0];
	if (entries === undefined || entries.kind() !== "array") return;
	const elements = childrenOf(entries);
	const spreads = elements.filter((child) => child.kind() === "spread_element");
	const keys: KeyRef[] = [];
	for (const element of elements) {
		if (element.kind() !== "array") continue;
		const head = childrenOf(element)[0];
		if (head === undefined) continue;
		const ref = expressionKeyRef(head, context.aliases());
		if (ref !== undefined) keys.push(ref);
	}
	if (keys.length === 0) return;
	const envIdentified = spreads.some((spread) =>
		/process\s*\.\s*(?:env|entries)\b/.test(spread.text()),
	);
	for (const key of keys) {
		out.push({
			line: key.line,
			spelling: key.spelling,
			shape: key.shape,
			kind: "literal",
			group: `fromEntries@${node.range().start.index}`,
			site: `Object.fromEntries@${node.range().start.line + 1}`,
			inheritsBase: spreads.length > 0,
			envIdentified,
			live: false,
		});
	}
}

/**
 * Every path-variable env write in `source` with the reason it is not the
 * sanctioned fresh single-spelling literal. An empty array means the file
 * composes the variable safely (or does not touch it).
 */
export interface PathKeyOptions {
	/**
	 * `true` for a `tests/**` file: a single-spelling `process.env.PATH = …`
	 * there is a harness PATH stub (set, exercise, restore), not a shipped env
	 * composition, and this sweep does not census them (limit 5). The dual
	 * spelling and every literal composition stay in scope — a stub that writes
	 * BOTH spellings is the defect, not the stub.
	 */
	ambientStubAllowed?: boolean;
}

export function findPathKeyFindings(
	source: string,
	options: PathKeyOptions = {},
): PathKeyFinding[] {
	const root = parse(Lang.TypeScript, source).root();
	const context = buildContext(root);
	const writes: RawWrite[] = [];

	// One parser pass over the node kinds that can WRITE a path key: the four
	// key forms an object literal has, a member write (dotted or subscript), and
	// the `Object.fromEntries` call that builds an env entry by entry. Every
	// admission is a node kind, never a text pattern, and each visitor reads the
	// key from the node it was handed.
	for (const node of root.findAll({
		rule: {
			any: [
				{
					kind: "pair",
					has: { kind: "property_identifier", regex: PATH_SPELLING },
				},
				{
					kind: "pair",
					has: { kind: "string", regex: PATH_STRING_KEY },
				},
				{ kind: "pair", has: { kind: "computed_property_name" } },
				{ kind: "shorthand_property_identifier", regex: PATH_SPELLING },
				{
					kind: "assignment_expression",
					has: {
						kind: "member_expression",
						has: { kind: "property_identifier", regex: PATH_SPELLING },
					},
				},
				{
					kind: "assignment_expression",
					has: { kind: "subscript_expression" },
				},
				{
					kind: "call_expression",
					has: {
						kind: "member_expression",
						has: { kind: "property_identifier", regex: "^fromEntries$" },
					},
				},
			],
		},
	})) {
		const kind = node.kind();
		if (kind === "assignment_expression") {
			collectMemberWrite(node, context, writes);
		} else if (kind === "call_expression") {
			collectFromEntries(node, context, writes);
		} else {
			collectKeyNode(node, context, writes);
		}
	}

	const groups = new Map<string, RawWrite[]>();
	for (const write of writes) {
		const group = groups.get(write.group);
		if (group === undefined) groups.set(write.group, [write]);
		else group.push(write);
	}

	const findings: PathKeyFinding[] = [];
	for (const [site, group] of groups) {
		const reason = groupReason(group, options.ambientStubAllowed === true);
		if (reason === undefined) continue;
		for (const write of group) {
			findings.push({
				line: write.line,
				spelling: write.spelling,
				reason,
				site,
			});
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

/** The sanctioned form is the only clean verdict; everything else names why. */
function groupReason(
	group: readonly RawWrite[],
	ambientStubAllowed: boolean,
): PathKeyReason | undefined {
	// Only a write whose text IS a spelling of the variable can share the
	// dual-spelling verdict. A computed key naming the variable
	// (`[pathToFileURL(f).href]`) is not a spelling, and two of them in one data
	// literal are not the defect.
	const named = group.filter((write) => write.shape !== "expression");
	const spellings = new Set(named.map((write) => write.spelling));
	if (spellings.size > 1) return "dual-spelling";
	const envIdentified = group.some((write) => write.envIdentified);
	if (group.some((write) => write.shape === "expression") && envIdentified) {
		return "unclassified-spelling";
	}
	const only = named[0];
	if (only === undefined) return undefined;
	switch (only.shape) {
		case "lowercase":
			// Limit 1: a lone lowercase `path` write is a data key as often as an
			// env key. It still counts as a participant above, where the
			// composition itself proves what it is.
			return envIdentified ? "unclassified-spelling" : undefined;
		case "case-variant":
			// No data key in the scanned trees uses a mixed-case spelling, and a
			// case-variant env write is exactly the defect: fail closed.
			return "unclassified-spelling";
		case "expression":
			// Limits 2 and 3: a computed key only names the variable, so the
			// composition has to prove it is an env.
			return envIdentified ? "unclassified-spelling" : undefined;
		case "canonical":
			break;
	}
	if (group.some((write) => write.live)) {
		return ambientStubAllowed ? undefined : "live-process-env";
	}
	if (group.some((write) => write.inheritsBase)) return "spread-override";
	if (group.some((write) => write.kind === "member")) {
		return "unclassified-spelling";
	}
	return undefined;
}

// Real per-tree floors, set below the population at authoring time
// (506/184/1662 files) so ordinary growth never trips them while a tree
// dropped from the walk reliably does (the #1718 empty-sweep shape).
const SCAN_ROOTS: ReadonlyArray<{
	dir: string;
	extensions: string[];
	floor: number;
}> = [
	{ dir: "clients", extensions: [".ts"], floor: 380 },
	{ dir: "scripts", extensions: [".ts", ".mjs"], floor: 100 },
	{ dir: "tests", extensions: [".ts", ".mjs"], floor: 600 },
];

/**
 * Admission filter for the parse (see the docstring): a path-folded word in a
 * key position — after a literal opener, a `.`, a `[` or an `=` — or a quoted
 * path value (a `const KEY = "Path"` alias). It runs on RAW source, so a
 * comment or a string can only admit a file, never hide one.
 */
const PATH_KEY_SHAPE = new RegExp(
	[
		// A path-folded word in literal-key, shorthand or member position.
		"(?:[{,(]|\\.\\s*)\\s*[\"'`]?[Pp][Aa][Tt][Hh][\"'`]?\\s*(?::|[,}\\]]|=[^=])",
		// A subscript or computed key that starts with a path-folded word.
		"\\[\\s*[\"'`]?[Pp][Aa][Tt][Hh]",
		// A quoted path value: the `const KEY = "Path"` alias form.
		"=\\s*[\"'`][Pp][Aa][Tt][Hh][\"'`]",
	].join("|"),
	"m",
);

/** Files admitted by {@link PATH_KEY_SHAPE} at authoring time (445 of 2,356). */
const ADMITTED_FILES_FLOOR = 200;

export interface PathKeyCensus {
	/** `file#declaration#spelling` → why it is a finding. */
	identities: Map<string, PathKeyReason>;
	findings: PathKeyFinding[];
	/** Files the walk read (the census population). */
	scanned: number;
	/** Files the admission filter sent to the parser. */
	admitted: number;
}

export function censusPathKeyCompositions(): PathKeyCensus {
	const files: string[] = [];
	for (const { dir, extensions, floor } of SCAN_ROOTS) {
		const found = listSourceFiles(path.join(REPO_ROOT, dir), {
			extensions,
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/`, found.length, floor);
		files.push(...found);
	}
	files.push(path.join(REPO_ROOT, "index.ts"));

	const identities = new Map<string, PathKeyReason>();
	const occurrences = new Map<string, number>();
	const findings: PathKeyFinding[] = [];
	let admitted = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		if (!PATH_KEY_SHAPE.test(source)) continue;
		admitted++;
		const rel = relativePosix(REPO_ROOT, file);
		const lines = source.split("\n");
		for (const finding of findPathKeyFindings(source, {
			ambientStubAllowed: /\.test\.[cm]?ts$/.test(rel),
		})) {
			const base = `${stableOccurrenceKey(rel, lines, finding.line - 1)}#${finding.spelling}`;
			// Two byte-identical flagged lines inside one declaration share the
			// content key (a test that sets and restores the same env write). The
			// n-th occurrence is disambiguated by order within the file, which is
			// deterministic because findings are sorted by line; the pair keeps
			// distinct rows so neither can excuse the other.
			occurrences.set(base, (occurrences.get(base) ?? 0) + 1);
			const seen = occurrences.get(base) as number;
			const identity = seen === 1 ? base : `${base}~${seen}`;
			identities.set(identity, finding.reason);
			findings.push(finding);
		}
	}
	return { identities, findings, scanned: files.length, admitted };
}

/**
 * Current offenders, by `file#declaration#spelling`.
 *
 * Every row is DEBT, not an approved composition: the tree composes the path
 * variable under two spellings (or over an inherited base) where a child on
 * Windows receives one name for two variables. They are seeded, not fixed,
 * because no call site adopts the shared composer yet — see the docstring's
 * "The composer exists; these call sites do not use it". A row that no longer
 * matches a live finding is stale and reds, so a fix must delete its row in the
 * same change; a finding with no row reds, so a new offender cannot join the
 * debt silently.
 */
const SEEDED_OFFENDERS: Readonly<Record<string, PathKeyReason>> = {
	// --- shipped clients/ ----------------------------------------------
	"clients/dispatch/runners/utils/runner-helpers.ts#getManagedToolEnvironment:459c017b#PATH":
		"dual-spelling",
	"clients/dispatch/runners/utils/runner-helpers.ts#getManagedToolEnvironment:655252cf#Path":
		"dual-spelling",
	"clients/installer/index.ts#getToolEnvironment:2675e706#Path":
		"dual-spelling",
	"clients/installer/index.ts#getToolEnvironment:459c017b#PATH":
		"dual-spelling",
	"clients/installer/index.ts#installPipTool:89cff3da#PATH": "dual-spelling",
	"clients/installer/index.ts#installPipTool:8b19a5cf#Path": "dual-spelling",
	// #4566 deletes this literal (clients/lsp/launch.ts:783) and the two rows
	// go with it; whichever of the two PRs lands second deletes them.
	"clients/lsp/launch.ts#launchLSP:459c017b#PATH": "dual-spelling",
	"clients/lsp/launch.ts#launchLSP:d1a02f78#Path": "dual-spelling",
	"clients/lsp/server.ts#tryGemInstall:6891b8bb#PATH": "live-process-env",
	"clients/python-environment.ts#augmentPythonEnvironment:0f4140e0#Path":
		"dual-spelling",
	"clients/python-environment.ts#augmentPythonEnvironment:459c017b#PATH":
		"dual-spelling",
	// --- shipped scripts/ ----------------------------------------------
	"scripts/guard-bash-probe.mjs#childEnv:26482799#PATH": "spread-override",
	"scripts/smoke-availability-lifecycle.mjs#main:cc494592#PATH":
		"live-process-env",
	// --- test fixtures (tests/) ----------------------------------------
	// A deliberate FENCE, not debt: `testEnv` deletes every path-folded key from
	// the copied env and then writes ONE spelling. The sweep cannot see the
	// delete loop from the write, so it reads as unclassified.
	"tests/clients/installer/installer-lifecycle.integration.test.ts#testEnv:809cb69e#PATH":
		"unclassified-spelling",
	"tests/clients/installer/pip-pep668.test.ts#runInstaller:e5211340#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#runResolved:a18d7145#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#writeConstraintAwarePipx:f7d1c605#PATH":
		"spread-override",
	"tests/clients/installer/pip-pep668.test.ts#writeConstraintAwarePipx:f7d1c605#PATH~2":
		"spread-override",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:06098579#PATH":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:3061167c#PATH":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:7a36028d#Path":
		"dual-spelling",
	"tests/clients/installer/tool-discovery.test.ts#withEmptyPath:cc3ed082#path":
		"dual-spelling",
	// Fixtures that DELIBERATELY set both spellings, to test which one
	// `mergeWindowsEnvironment` picks. The lint cannot tell a simulated Windows
	// block from an accidental one, so the rows are seeded; a fixture helper
	// that names the intent can leave them.
	"tests/clients/safe-spawn-windows-command.test.ts#d8954296#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#70587e36#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#8601dcf0#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#8601dcf0#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#1e0c5e10#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-command.test.ts#1e0c5e10#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#PATH~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#PATH~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:2fdc3229#Path~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path~2":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:dd414cb0#Path~3":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:becc49c4#PATH":
		"dual-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:becc49c4#Path":
		"dual-spelling",
	// The same file's case-variant fixtures: `{ pAtH: "caller-path" }` is the
	// override the merge must fold, and `pAtH`/`pAtHeXt` are the deliberate
	// odd-casing block. Both are the fixture's subject (limit 1: a mixed-case
	// spelling fails closed).
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:a0da0fff#pAtH":
		"unclassified-spelling",
	"tests/clients/safe-spawn-windows-resolution.test.ts#markFilesAsPresent:f14b6003#pAtH":
		"unclassified-spelling",
	"tests/clients/turn-scenarios.test.ts#knipUnavailableReason:8aacd496#PATH":
		"unclassified-spelling",
	"tests/scripts/astgrep-self-scan.test.ts#d:9989b09e#PATH": "spread-override",
	"tests/scripts/check-pr-body.test.ts#existsBaseFixtures:bf4943de#PATH":
		"spread-override",
	"tests/scripts/ci-test-diff.test.ts#fixture:e9d36405#PATH": "spread-override",
	"tests/scripts/ci-verdict.test.ts#31e1b4f8#PATH": "spread-override",
	"tests/scripts/download-test-history-artifacts.test.ts#fakeGh:e5468918#PATH":
		"spread-override",
	"tests/scripts/floor-steps-executed.test.ts#runStep:3e111efd#PATH":
		"spread-override",
	"tests/scripts/install-smoke-handshake-steps.test.ts#bash:8c06ec3b#PATH":
		"spread-override",
	"tests/scripts/lane-check.test.ts#runLane:f2fe9f48#PATH": "spread-override",
	"tests/scripts/lint-js.test.ts#runNodeWithOxlint:e2627086#PATH":
		"spread-override",
	"tests/scripts/notify-install-smoke-drift.test.ts#EXISTING_TRACKER:7b47e8d1#PATH":
		"spread-override",
	"tests/scripts/notify-install-smoke-drift.test.ts#runReal:8e11d0c7#PATH":
		"spread-override",
	"tests/scripts/notify-tool-smoke-red.test.ts#GREEN_ENV:7b47e8d1#PATH":
		"spread-override",
	"tests/scripts/notify-tool-smoke-red.test.ts#runReal:8e11d0c7#PATH":
		"spread-override",
	"tests/scripts/npm-retry.test.ts#runCli:7b47e8d1#PATH": "spread-override",
	"tests/scripts/npm-retry.test.ts#runCli:7b47e8d1#PATH~2": "spread-override",
	"tests/scripts/pre-commit-hook.test.ts#enterFixture:13462f5c#PATH":
		"spread-override",
	// `Object.assign(env, { PATH: … })` on an env copied from `envFor(root)`:
	// the same shape as a member write, and the copied env keeps whatever
	// spelling the ambient block carried.
	"tests/scripts/pre-push-targeted-tests.test.ts#enterFixture:256ee0ba#PATH":
		"unclassified-spelling",
	"tests/scripts/red-on-base.test.ts#run:9af7db0a#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:11e81b7f#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:ca835e61#PATH": "spread-override",
	"tests/scripts/release-qa.test.ts#row:f4153f23#PATH": "spread-override",
	"tests/scripts/resolve-newest-in-range-host.test.ts#runCli:2b7ac868#PATH":
		"spread-override",
	"tests/scripts/resolve-newest-in-range-host.test.ts#runCli:7b47e8d1#PATH":
		"spread-override",
};

const REMEDIATION =
	"Compose a child env as a FRESH object literal with ONE path spelling " +
	"(`{ PATH: next }`), or route the write through " +
	"`mergeWindowsEnvironment` (clients/safe-spawn.ts) — then delete the " +
	"baseline row in tests/config/env-path-key-composition-sweep.test.ts. " +
	"Refs #4590.";

describe("#4590 env PATH composition", () => {
	it("flags a composition that writes both PATH and Path", () => {
		const findings = findPathKeyFindings(
			[
				"const child = {",
				"\t...base,",
				"\tPATH: augmented,",
				"\t...(isWindows ? { Path: augmented } : {}),",
				"};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PATH", "dual-spelling"],
			[4, "Path", "dual-spelling"],
		]);
	});

	it("flags a spread plus an override, and a helper-composed base", () => {
		const findings = findPathKeyFindings(
			[
				"export function scoped(env: NodeJS.ProcessEnv) {",
				"\treturn { ...env, PATH: next(env) };",
				"}",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[2, "PATH", "spread-override"],
		]);
	});

	it("resolves a computed key through a literal-const alias", () => {
		const findings = findPathKeyFindings(
			[
				'const PATH_KEY = "Path";',
				"const env = { ...base, [PATH_KEY]: next };",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[2, "Path", "spread-override"],
		]);
	});

	it("flags a live process.env write, and both spellings of it", () => {
		const single = findPathKeyFindings(
			"process.env.PATH = `${dir}${sep}PATH`;",
		);
		expect(single.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "live-process-env"],
		]);
		const both = findPathKeyFindings(
			[
				"process.env.PATH = updated;",
				"if (isWindows) process.env.Path = updated;",
			].join("\n"),
		);
		expect(both.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "dual-spelling"],
			[2, "Path", "dual-spelling"],
		]);
	});

	it("flags a member write on a base it cannot see, and an unrecognised spelling in an env", () => {
		const opaque = findPathKeyFindings(
			'function apply(env, value) { env["PATH"] = value; }',
		);
		expect(opaque.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "unclassified-spelling"],
		]);
		const odd = findPathKeyFindings(
			[
				"const env: NodeJS.ProcessEnv = {",
				"\t...base,",
				"\tPaTh: next,",
				"};",
			].join("\n"),
		);
		expect(odd.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PaTh", "unclassified-spelling"],
		]);
	});

	it("reads a quoted key from raw source and a shorthand entry from code", () => {
		const quoted = findPathKeyFindings(
			['const env = { ...base, "PATH": next };'].join("\n"),
		);
		expect(quoted.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "spread-override"],
		]);
		const shorthand = findPathKeyFindings(
			["const env = { ...base, PATH };", "env.Path = next;"].join("\n"),
		);
		expect(shorthand.map((f) => [f.line, f.reason])).toEqual([
			[1, "dual-spelling"],
			[2, "dual-spelling"],
		]);
	});

	/**
	 * Shape 69's other two plants: an INDIRECT call into the same binding
	 * (`Object.assign`), and a computed key that names a path expression in an
	 * object that is NOT an env — the fail-closed arm must not fire there.
	 */
	it("follows an indirect call into the same binding", () => {
		const findings = findPathKeyFindings(
			[
				"const env = { PATH: first };",
				"Object.assign(env, { Path: second });",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "dual-spelling"],
			[2, "Path", "dual-spelling"],
		]);
	});

	/**
	 * The block filter (`opensObjectLiteral`) is load-bearing: without it the
	 * enclosing function BODY reads as the composition, its `ProcessEnv` return
	 * type identifies it as an env, and two unrelated compositions in one
	 * function merge into a false dual spelling.
	 */
	it("keeps sibling compositions in one function apart", () => {
		const findings = findPathKeyFindings(
			[
				"export function build(seed: NodeJS.ProcessEnv): NodeJS.ProcessEnv {",
				'\tconst first = { PATH: "a" };',
				'\tconst second = { Path: "b" };',
				"\treturn second;",
				"}",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("leaves a computed key outside an env composition alone", () => {
		const findings = findPathKeyFindings(
			[
				"const changes = { [pathToFileURL(importPath).href]: [] };",
				"const labels = { [PathKey]: value };",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does not flag the needle inside a comment or a string", () => {
		const findings = findPathKeyFindings(
			[
				"// the old shape wrote { PATH: next, Path: next } here",
				'/* and env["PATH"] = next; in a block comment */',
				'const note = "const env = { ...base, PATH: next }; Path: next";',
				"const other = 'process.env.PATH = updated;';",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does not flag the sanctioned fresh single-spelling literal", () => {
		const findings = findPathKeyFindings(
			[
				'const probeEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C" };',
				"const env: NodeJS.ProcessEnv = { PATH: next };",
				"const data = { path: filePath, target: other };",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	/**
	 * The #4566 round-14 shape, frozen from
	 * `git show c40ca054b^:clients/lsp/launch.ts` (lines 810-814): the dual
	 * spelling literal the round-10 fix replaced with `setTrustScopedPath`. The
	 * same literal is still on master in `clients/lsp/launch.ts:783`; #4566
	 * deletes it, and whichever PR lands second deletes its two seed rows.
	 */
	it("flags the #4566 round-14 launcher env, frozen from the pre-fix commit", () => {
		const findings = findPathKeyFindings(
			[
				"\tconst env: NodeJS.ProcessEnv = {",
				"\t\t...mergedEnv,",
				"\t\tPATH: augmentedPath,",
				"\t\t...(isWindows ? { Path: augmentedPath } : {}),",
				"\t};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PATH", "dual-spelling"],
			[4, "Path", "dual-spelling"],
		]);
	});

	/**
	 * #4600 F1: the call-built forms. `Object.assign` and `Object.fromEntries`
	 * compose an env without an object literal that holds the key in its own
	 * member list, and the round-1 text scan recorded nothing for them, so a
	 * planted offender left the census green.
	 */
	it("flags a call-built env and names what it inherits", () => {
		const assignOverEnv = findPathKeyFindings(
			"const child = Object.assign({}, process.env, { PATH: next });",
		);
		expect(assignOverEnv.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "spread-override"],
		]);
		const assignLive = findPathKeyFindings(
			"Object.assign(process.env, { Path: next });",
		);
		expect(assignLive.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "Path", "live-process-env"],
		]);
		const fromEntries = findPathKeyFindings(
			[
				'const child = Object.fromEntries([...Object.entries(process.env), ["PATH", next]]);',
			].join("\n"),
		);
		expect(fromEntries.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PATH", "spread-override"],
		]);
		const intoOpaque = findPathKeyFindings(
			"function apply(env: NodeJS.ProcessEnv, v) { Object.assign(env, { Path: v }); }",
		);
		expect(intoOpaque.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "Path", "unclassified-spelling"],
		]);
	});

	/**
	 * #4600 F2: a key that starts on its own line. The round-1 patterns
	 * excluded the newline after `{`/`,`, and `oxfmt` formats a multi-member
	 * literal exactly that way, so the verdict depended on layout.
	 */
	it("flags a quoted or computed key that starts on its own line", () => {
		const formatted = findPathKeyFindings(
			[
				"export function built(next: string): NodeJS.ProcessEnv {",
				"\treturn {",
				"\t\t...process.env,",
				'\t\t"PATH": next,',
				"\t};",
				"}",
			].join("\n"),
		);
		expect(formatted.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[4, "PATH", "spread-override"],
		]);
		const computed = findPathKeyFindings(
			[
				'const PATH_KEY = "Path";',
				"const env: NodeJS.ProcessEnv = {",
				"\t...base,",
				"\t[PATH_KEY]: next,",
				"};",
			].join("\n"),
		);
		expect(computed.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[4, "Path", "spread-override"],
		]);
		const formattedDual = findPathKeyFindings(
			[
				"const child = {",
				"\t...base,",
				'\t"PATH": first,',
				'\t"Path": second,',
				"};",
			].join("\n"),
		);
		expect(formattedDual.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[3, "PATH", "dual-spelling"],
			[4, "Path", "dual-spelling"],
		]);
	});

	/**
	 * #4600 F5: a spread ARGUMENT is not an inherited base. Only a spread in
	 * member position copies another object's keys into this one.
	 */
	it("does not read a rest argument as an inherited base", () => {
		const findings = findPathKeyFindings(
			[
				"const env = { PATH: path.join(...segments) };",
				"const other = { PATH: segments.join(...parts) };",
				"const merged: NodeJS.ProcessEnv = {",
				"\t...(isWindows ? { PATH: next } : {}),",
				"};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[4, "PATH", "spread-override"],
		]);
	});

	/**
	 * #4600 F6: the composition is the OBJECT, not the binding name. Two
	 * scopes that happen to declare `env`, and a nested data object, are
	 * separate compositions.
	 */
	it("keeps same-named bindings in different scopes apart", () => {
		const findings = findPathKeyFindings(
			[
				"function first() { const env = { PATH: a }; return env; }",
				"function second() { const env = { Path: b }; return env; }",
				"const outer: NodeJS.ProcessEnv = { PATH: c, extra: { Path: d } };",
			].join("\n"),
		);
		expect(findings).toEqual([]);
		// Two blocks of ONE function: the binding NAME alone would merge these,
		// so the composition identity has to be the declaration.
		const siblingBlocks = findPathKeyFindings(
			[
				"function shadow(flag) {",
				"\tif (flag) { const env = { PATH: a }; return env; }",
				"\t{ const env = { Path: b }; return env; }",
				"}",
			].join("\n"),
		);
		expect(siblingBlocks).toEqual([]);
	});

	/**
	 * #4600 compliance F3: the member arm fails closed on a spelling the tree
	 * never uses as a data key, instead of only on the two canonical literals.
	 */
	it("fails closed on a mixed-case member spelling", () => {
		const findings = findPathKeyFindings(
			"function apply(env, value) { env.PaTh = value; }",
		);
		expect(findings.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "PaTh", "unclassified-spelling"],
		]);
		const data = findPathKeyFindings("state.path = next;");
		expect(data).toEqual([]);
		// Limit 1's two directions: a lowercase `path` is a finding in an env
		// composition and a data key everywhere else.
		const lowercaseInEnv = findPathKeyFindings(
			"const env: NodeJS.ProcessEnv = { path: next };",
		);
		expect(lowercaseInEnv.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "path", "unclassified-spelling"],
		]);
		// The other two ways a composition proves it is an env: it sits in an
		// `env:` position, and the member write's base is a `ProcessEnv`.
		const envPosition = findPathKeyFindings(
			"const spawn = { env: { path: next } };",
		);
		expect(envPosition.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "path", "unclassified-spelling"],
		]);
		const typedBase = findPathKeyFindings(
			"function apply(env: NodeJS.ProcessEnv) { env.path = next; }",
		);
		expect(typedBase.map((f) => [f.line, f.spelling, f.reason])).toEqual([
			[1, "path", "unclassified-spelling"],
		]);
	});

	/**
	 * Limits 2 and 3: a computed key that only NAMES the variable is a finding
	 * in an env composition and nothing elsewhere.
	 */
	it("fails closed on a computed key naming the variable inside an env", () => {
		const findings = findPathKeyFindings(
			[
				"const env: NodeJS.ProcessEnv = {",
				'\t[pathKeyFor("PATH")]: next,',
				"};",
			].join("\n"),
		);
		expect(findings.map((f) => [f.line, f.reason])).toEqual([
			[2, "unclassified-spelling"],
		]);
	});

	it(
		"keeps the seeded baseline exact in both directions",
		() => {
			const census = censusPathKeyCompositions();
			assertNonEmptyScan(
				"env PATH composition candidates",
				census.admitted,
				ADMITTED_FILES_FLOOR,
			);
			const audit = auditRegistry({
				sweepName: "env PATH composition",
				flagged: [...census.identities].map(([key, reason]) => ({
					key,
					detail: reason,
				})),
				// The baseline is an EXEMPTION table: a row that stops matching reds as
				// stale, which a `registered` entry never does (the kit's asymmetry).
				registered: [],
				exemptions: SEEDED_OFFENDERS,
				// The exemption's "reason" is an enum verdict, compared for DRIFT
				// below instead of by length.
				minReasonLength: 1,
				scannedCount: census.scanned,
				minScanned: 1000,
				remediation: REMEDIATION,
			});
			expect(audit.problems).toEqual([]);
			const drifted = [...census.identities]
				.filter(
					([identity, reason]) =>
						SEEDED_OFFENDERS[identity] !== undefined &&
						SEEDED_OFFENDERS[identity] !== reason,
				)
				.map(
					([identity, reason]) =>
						`${identity}: seeded ${SEEDED_OFFENDERS[identity]}, now ${reason}`,
				);
			expect(
				drifted,
				"A seeded row changed its reason; re-read the site.",
			).toEqual([]);
		},
		// The walk is the work: ~2,350 files read, 445 of them parsed and scanned
		// by one structural query (~3 s on the authoring box; the same census as a
		// full-tree text scan timed this case out at its 5 s default on the
		// Windows lane, #4600 F3). This ceiling only bounds a pathological runner;
		// the speed comes from the admission filter and the lazy binding table,
		// not from the budget.
		60_000,
	);
});
