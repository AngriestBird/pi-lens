/**
 * #4589: unrestored `process.env` writes in test source.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * assigns or deletes an environment variable and nothing puts it back, so the
 * NEXT case in the same worker inherits the value.
 *
 * The detector is pure and takes one file's raw source. It reads the
 * comment- and string-BLANKED text (`stripSource`), so a needle quoted in a
 * comment or inside a fixture string is not a write (principles §2,
 * "detectors match code, not prose"), and reads VALUES back out of the raw
 * source at the offsets the blanked text reported, because `stripSource`
 * preserves length.
 *
 * ## The write enumerator fails closed (shape 69)
 *
 * The population is every `process.env` write, derived from the seam rather
 * than from a list of operators. Each `process.env` reference is classified
 * from the token that follows it:
 *
 * - `.KEY`, `[expr]`, `?.KEY`, `?.[expr]`, `!.KEY` and `![expr]` followed by
 *   an assignment operator of ANY spelling is a write (`=`, `+=`, `&&=`,
 *   `||=`, `??=`, and a `=` on a later line); the optional-chain and non-null
 *   postfix operators continue the same member chain, and so does a grouping
 *   or cast the reference is the whole of (`(process.env).K`,
 *   `(process.env as T).K`, `(process.env satisfies T)[K]`);
 * - `delete` before it is a delete;
 * - `process.env = …` is a whole-environment write;
 * - `Object.assign(process.env, …)`, `Object.defineProperty(process.env, …)`
 *   and their `Reflect` twins are writes;
 * - a local alias bound from `process.env` (`const env = process.env`) is the
 *   same seam, so `env.KEY = …`, `env?.KEY = …`, and a mutator whose subject
 *   it is (`Object.assign(env, …)`) are writes;
 * - `globalThis.process.env`, `window.process.env`, `self.process.env` and
 *   `global.process.env` are the same seam;
 * - a VALUE read is the closed set of followers in `READ_FOLLOW` (`;`, `,`,
 *   `)`, `}`, `]`, `:`, `?`, a comparison or boolean operator, `as`,
 *   `satisfies`, `in`, `instanceof`).
 *
 * A reference that is none of those becomes an `unclassified` finding, and so
 * does a `process.env` member used as a destructuring assignment target. An
 * unrecognised spelling is therefore a red, never a silent pass, the
 * fail-closed direction AGENTS.md shape 69 requires.
 *
 * ## The restore rule is structural, not shape-of-call
 *
 * An accepted restore is one of exactly five shapes, each decided from
 * structure:
 *
 * 1. an `afterEach`/`afterAll` `delete` of the key, in a teardown whose
 *    `describe` chain is a PREFIX of the write's: a top-level teardown covers
 *    every write, a sibling `describe`'s teardown covers none of them;
 * 2. an `afterEach`/`afterAll` assignment of the key whose right side is a
 *    value saved OUTSIDE that teardown (a name declared before it, a property
 *    of such a name, or a loop binding fed by such a name) — a literal
 *    assignment is a write, not a restore;
 * 3. a teardown loop that writes through its own variable over a declared key
 *    list (`for (const key of ENV_KEYS) delete process.env[key]`) or over a
 *    saved-value record (`for (const [k, v] of Object.entries(saved))`);
 * 4. a teardown call to a FILE-LOCAL function, one hop, with its parameters
 *    bound to the call's arguments — `restore("K", previous.k)` where the
 *    file's own `restore` deletes or re-assigns `process.env[name]`;
 * 5. a `finally` block in the SAME enclosing function as the write, under
 *    rules 2 and 3;
 * 6. a whole-environment assignment whose right side is a SINGLE spread of a
 *    name saved outside the region (`process.env = { ...saved }`); a copy of
 *    the live environment (`{ ...process.env }`) and a fresh literal restore
 *    nothing;
 * 7. a teardown `Object.assign(process.env, saved)` whose value argument is a
 *    name saved outside the region.
 *
 * `vi.stubEnv(...)` is restored only by `vi.unstubAllEnvs()` in a covering
 * teardown or finally. A write inside a teardown body is reported unless the
 * write itself is one of those shapes, and a call is never a restore because
 * it happens to carry two arguments: the callee's body decides.
 *
 * Anything else is a finding and belongs in the baseline. The detector never
 * accepts a shape it cannot read: a computed key, a concise-arrow teardown
 * whose helper body sits outside this file, a helper the file imports, a
 * `finally` in another function, an `Object.defineProperty` descriptor. It
 * reports the write instead, the direction that keeps a leak a red rather
 * than a silent pass (AGENTS.md shape 69). A baseline row therefore means
 * "this write is not provably restored here", and it shrinks when the file is
 * made readable.
 */

import {
	callbackBodyBrace,
	isFunctionBrace,
	lineOf,
	matchingCloseIndex,
	nextNonSpace,
	stripSource,
} from "./sweep-kit.js";

/** How the site writes the environment. */
export type EnvWriteKind = "assign" | "delete" | "stub" | "unclassified";

/** One env write, restored or not. */
export interface EnvWriteSite {
	/** `PI_LENS_HOME`, `ENV_REVIEW_GRAPH_MAX` for a computed key, or `<process.env>`. */
	key: string;
	kind: EnvWriteKind;
	/** 1-based line in the file. */
	line: number;
	/** Offset of the write in the blanked text. */
	start: number;
}

/** A write no accepted restore covers. */
export interface EnvRestoreFinding extends EnvWriteSite {
	file: string;
}

interface Range {
	start: number;
	end: number;
}

/**
 * A write the detector found, with the offsets a restore region needs to read
 * its key and its assigned value. Never leaves this module.
 */
interface Site extends EnvWriteSite {
	/** The raw text of the key, or "" for a whole-environment write. */
	keyExpr: string;
	/** Offset just past the key; the assignment operator follows it. */
	keyEnd: number;
	/** The syntactic role that produced the site. */
	form: "member" | "whole" | "mutator" | "stub";
	/** A mutator call's value argument, raw. */
	valueExpr?: string;
}

/** One restorable thing a region puts back, and the region that does it. */
interface RestoreHit {
	/** The environment key restored, or `*` for every `vi.stubEnv` key. */
	key: string;
	/** Offset of the restoring site. */
	pos: number;
	/** Where the restore runs, and therefore what it can cover. */
	scope: RestoreScope;
}

/**
 * What a restore can cover: a teardown runs for its `describe` chain and every
 * suite nested in it, a `finally` runs for the one function body holding it.
 */
type RestoreScope =
	| { kind: "teardown"; chain: readonly Range[] }
	| { kind: "finally"; owner: Range };

/** One file's blanked text, raw text and brace-derived ranges. */
interface Scan {
	raw: string;
	stripped: string;
	bodies: Range[];
}

/** What a helper parameter receives at one call site. */
type ParamBinding =
	| { kind: "key"; keys: string[] }
	| { kind: "value"; saved: boolean };

/** One readable body of a restore region, with its parameter bindings. */
interface Piece {
	range: Range;
	params: Map<string, ParamBinding>;
}

/** A teardown or `finally` region, expanded one hop into file-local helpers. */
interface RestoreRegion {
	scope: RestoreScope;
	pieces: Piece[];
}

const SEAM =
	/(?<![\w$])(?:(?:globalThis|window|self|global)\s*\.\s*)?process\s*\.\s*env(?![\w$])/g;
const ALIAS_DECL =
	/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:(?:globalThis|window|self|global)\s*\.\s*)?process\s*\.\s*env(?![\w$])/g;
const MUTATOR =
	/(?<![\w$])(?:Object\s*\.\s*(assign|defineProperty|defineProperties)|Reflect\s*\.\s*(set|deleteProperty|defineProperty))\s*\(/g;
const STUB_ENV = /(?<![\w$.])vi\s*\.\s*stubEnv\s*\(/g;
const UNSTUB_ENV = /(?<![\w$.])vi\s*\.\s*unstubAllEnvs\s*\(/g;
const TEARDOWN = /(?<![\w$.])(?:afterEach|afterAll)(?![\w$])/g;
const DESCRIBE = /(?<![\w$.])describe(?![\w$])/g;
const HOISTED = /(?<![\w$.])vi\s*\.\s*hoisted\s*\(/g;
const KEY_LIST_LOOP =
	/(?<![\w$.])for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g;
/**
 * `for (const [KEY, VALUE] of Object.entries(RECORD))`,
 * `for (const KEY of Object.keys(RECORD))` and the array-destructured twin.
 */
const RECORD_LOOP =
	/(?<![\w$.])for\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s+of\s+Object\s*\.\s*(entries|keys)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;
const CALL_SITE =
	/(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/g;
const DECLARATION = /(?<![\w$.])(?:const|let|var)\s+/g;
/** Callees that take their own argument list before the declaration call. */
const ARGUMENT_TAKING_MODIFIERS = new Set(["each", "skipIf", "runIf", "for"]);
/** The whole-environment key a wildcard write or restore carries. */
const WHOLE_ENV = "<process.env>";

/**
 * A key the detector cannot read statically keeps its expression, whitespace
 * collapsed, so the same variable's write and restore still match and a
 * baseline row is stable across line moves. `escapeRowKey` removes the spaces
 * a row may not carry.
 */
function normalizeKey(raw: string): string {
	const text = raw.trim();
	const literal = stringLiteral(text);
	if (literal !== undefined) return literal || `<empty>${text}`;
	if (/^[A-Za-z_$][\w$]*$/.test(text)) return text;
	return `[${text.replace(/\s+/g, " ")}]`;
}

/**
 * The contents of ONE string literal, or `undefined` when `text` is not one. A
 * concat (`"PI_LENS_" + "HOME"`) starts and ends with a quote without being a
 * literal, so the closing quote must be the last character and no unescaped
 * quote of the same kind may sit inside.
 */
function stringLiteral(text: string): string | undefined {
	const quote = text[0];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	if (text.length < 2 || text[text.length - 1] !== quote) return undefined;
	const body = text.slice(1, -1);
	if (body.includes(quote)) return undefined;
	return body.replace(/\\(.)/g, "$1");
}

function precedingWord(stripped: string, index: number): string {
	let i = index - 1;
	while (i >= 0 && /\s/.test(stripped[i])) i--;
	const end = i;
	while (i >= 0 && /[\w$]/.test(stripped[i])) i--;
	return stripped.slice(i + 1, end + 1);
}

/** Skip whitespace, newlines included, so a `=` on the next line still counts. */
function afterGap(stripped: string, index: number): number {
	let i = index;
	while (i < stripped.length && /\s/.test(stripped[i])) i++;
	return i;
}

/**
 * Offset of the assignment operator after `from`, or -1. `==`, `===`, `=>`,
 * `!=`, `<=` and `>=` are comparisons. Every compound spelling counts: `+=`,
 * `&&=`, `||=` and `??=` are writes like `=` is.
 */
const ASSIGN_OPERATOR = /^(?:[-+*/%&|^]|\*\*|<<|>>|>>>|\|\||&&|\?\?)?=(?!=|>)/;

function assignmentAt(stripped: string, from: number): number {
	const at = afterGap(stripped, from);
	return ASSIGN_OPERATOR.test(stripped.slice(at, at + 5)) ? at : -1;
}

/**
 * The closed set of characters that may follow a `process.env` reference used
 * as a VALUE. Anything outside it, and outside the assignment forms above, is
 * an unrecognised spelling and becomes an `unclassified` finding.
 */
const READ_FOLLOW = new Set([
	",",
	")",
	";",
	"}",
	"]",
	":",
	"?",
	"&",
	"|",
	"!",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"^",
]);
const READ_KEYWORD = /^(?:as|satisfies|instanceof|in|of)\b/;

/** Does the `process.env` reference run inside a destructuring assignment target? */
function inAssignmentTarget(stripped: string, at: number): boolean {
	let depth = 0;
	for (let i = at - 1; i >= 0; i--) {
		const ch = stripped[i];
		if (ch === ")" || ch === "]" || ch === "}") {
			depth++;
			continue;
		}
		if (ch !== "(" && ch !== "[" && ch !== "{") continue;
		if (depth > 0) {
			depth--;
			continue;
		}
		// Only a pattern can be a destructuring target: `[a, b] = …` or
		// `({ a: b } = …)`. A `(` groups or calls, so it is not one.
		if (ch === "(") return false;
		const close = matchingCloseIndex(stripped, i, ch, ch === "[" ? "]" : "}");
		if (close < 0) return false;
		return assignmentAt(stripped, close + 1) >= 0;
	}
	return false;
}

/** Names declared as `const NAME = process.env` anywhere in the file. */
function aliasNames(stripped: string): Map<string, number> {
	const aliases = new Map<string, number>();
	for (const match of stripped.matchAll(ALIAS_DECL)) {
		const name = match[1];
		const at = match.index ?? 0;
		if (name !== undefined) aliases.set(name, at + match[0].indexOf(name));
	}
	return aliases;
}

/**
 * Where a member chain continues after the expression ending at `end`, or
 * undefined when the next token does not access a member. The optional-chain
 * and non-null postfix operators are the same chain, so `env?.K`, `env!.K`,
 * `env?.[k]` and `env![k]` all reach the member or the index below.
 */
function memberAccessAt(
	stripped: string,
	end: number,
): { at: number; kind: "dot" | "bracket" } | undefined {
	switch (stripped[afterGap(stripped, end)]) {
		case "?": {
			const at = afterGap(stripped, end);
			if (stripped[at + 1] !== ".") return undefined;
			const name = afterGap(stripped, at + 2);
			return stripped[name] === "["
				? { at: name, kind: "bracket" }
				: { at: at + 1, kind: "dot" };
		}
		case "!": {
			const at = afterGap(stripped, afterGap(stripped, end) + 1);
			if (stripped[at] === "." || stripped[at] === "[")
				return {
					at,
					kind: stripped[at] === "[" ? "bracket" : "dot",
				};
			return stripped[at] === "?" && stripped[at + 1] === "."
				? memberAccessAt(stripped, at)
				: undefined;
		}
		case ".":
			return { at: afterGap(stripped, end), kind: "dot" };
		case "[":
			return { at: afterGap(stripped, end), kind: "bracket" };
		default:
			return undefined;
	}
}

/**
 * The grouping or cast that WRAPS only this reference (`(process.env)`,
 * `(process.env as T)`, `(process.env satisfies T)`), or undefined. A call's
 * `(` is not a grouping, so `expect(process.env)` stays a value read.
 */
function wrapperEnd(
	stripped: string,
	start: number,
	end: number,
): { open: number; end: number } | undefined {
	let open = start - 1;
	while (open >= 0 && /\s/.test(stripped[open])) open--;
	if (open < 0 || stripped[open] !== "(") return undefined;
	const before = stripped[open - 1];
	if (before !== undefined && /[\w$)\]]/.test(before)) return undefined;
	const close = matchingCloseIndex(stripped, open, "(", ")");
	if (close < end) return undefined;
	const inner = stripped.slice(end, close).trim();
	// Bare grouping or a cast, never a larger expression whose role we would
	// be guessing at.
	if (inner !== "" && !/^(?:as|satisfies)\s/.test(inner)) return undefined;
	return { open, end: close + 1 };
}

/**
 * Every `process.env` reference in the file, including each alias of it, and
 * every position where the env OBJECT itself starts (which a mutator call's
 * first argument must be). The declaration that CREATES an alias is not a
 * reference: it is followed by `=` and would otherwise read as a
 * whole-environment write of the alias.
 */
function seamRefs(stripped: string): {
	members: Array<{ at: number; end: number }>;
	objects: Map<number, number>;
} {
	const members: Array<{ at: number; end: number }> = [];
	const objects = new Map<number, number>();
	for (const match of stripped.matchAll(SEAM)) {
		const at = match.index ?? 0;
		members.push({ at, end: at + match[0].length });
		objects.set(at, at + match[0].length);
	}
	for (const [name, declAt] of aliasNames(stripped)) {
		const uses = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
		for (const match of stripped.matchAll(uses)) {
			const at = match.index ?? 0;
			if (at === declAt) continue;
			objects.set(at, at + name.length);
			// An alias is mutated only through a member, an index or a mutator
			// call; any other use (`pass(env)`, `{ ...env }`) reads the object.
			if (memberAccessAt(stripped, at + name.length) === undefined) continue;
			members.push({ at, end: at + name.length });
		}
	}
	return { members, objects };
}

/** The raw text of a call's `index`-th argument (0-based). */
function argumentAt(
	scan: Scan,
	paren: number,
	close: number,
	index: number,
): string {
	let depth = 0;
	let seen = 0;
	let start = paren + 1;
	for (let i = paren + 1; i < close; i++) {
		const ch = scan.stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			if (seen === index) return scan.raw.slice(start, i);
			seen++;
			start = i + 1;
		}
	}
	return index === seen ? scan.raw.slice(start, close) : "";
}

/**
 * End offset of the env object expression starting at `at`, or -1. A grouping
 * or cast around it (`(process.env as T)`) is the same object.
 */
function envObjectEnd(
	scan: Scan,
	objects: ReadonlyMap<number, number>,
	at: number,
): number {
	const { stripped } = scan;
	const start = nextNonSpace(stripped, at);
	if (stripped[start] === "(") {
		const close = matchingCloseIndex(stripped, start, "(", ")");
		if (close < 0) return -1;
		const inner = envObjectEnd(scan, objects, start + 1);
		if (inner < 0) return -1;
		const rest = stripped.slice(inner, close).trim();
		if (rest !== "" && !/^(?:as|satisfies)\s/.test(rest)) return -1;
		return close + 1;
	}
	return objects.get(start) ?? -1;
}

/** One `Object.*` / `Reflect.*` call whose first argument is the env object. */
function mutatorSites(
	scan: Scan,
	objects: ReadonlyMap<number, number>,
): Site[] {
	const sites: Site[] = [];
	for (const match of scan.stripped.matchAll(MUTATOR)) {
		const at = match.index ?? 0;
		const paren = at + match[0].length - 1;
		const close = matchingCloseIndex(scan.stripped, paren, "(", ")");
		if (close < 0) continue;
		const first = nextNonSpace(scan.stripped, paren + 1);
		const objectEnd = envObjectEnd(scan, objects, first);
		if (objectEnd < 0) continue;
		// The env object must BE the first argument: `Object.assign(env.PATH, …)`
		// writes a member's object, and a one-argument call writes nothing.
		if (scan.stripped[afterGap(scan.stripped, objectEnd)] !== ",") continue;
		// A descriptor is not a saved value, and the key it defines is the
		// second argument: report that key, never accept the call as a restore.
		const descriptor =
			/(?:defineProperty|defineProperties)$/.test(match[1] ?? "") ||
			/defineProperty$/.test(match[2] ?? "");
		const assign =
			/^assign$/.test(match[1] ?? "") || /^set$/.test(match[2] ?? "");
		const whole = /deleteProperty$/.test(match[2] ?? "");
		const valueExpr = argumentAt(scan, paren, close, 1);
		const keyExpr = descriptor || whole ? valueExpr : "";
		sites.push({
			key: descriptor || whole ? normalizeKey(keyExpr) : WHOLE_ENV,
			kind: assign && !descriptor ? "assign" : "unclassified",
			line: lineOf(scan.stripped, at),
			start: at,
			keyExpr,
			keyEnd: close,
			form: "mutator",
			valueExpr: assign && !descriptor ? valueExpr : undefined,
		});
	}
	return sites;
}

/**
 * One `process.env` reference's write, or undefined when it reads the
 * environment. An unrecognised follower is an `unclassified` write: the seam
 * was reached, so the enumerator must not stay silent about it.
 */
function siteFromRef(scan: Scan, at: number, end: number): Site | undefined {
	const { stripped } = scan;
	const deleted = precedingWord(stripped, at) === "delete";
	// A grouping or cast around the reference (`(process.env).K`,
	// `(process.env as T)[K]`) is the same object, so its chain starts after
	// the wrapper rather than at the reference itself.
	let exprStart = at;
	let exprEnd = end;
	for (;;) {
		const wrapper = wrapperEnd(stripped, exprStart, exprEnd);
		if (wrapper === undefined) break;
		exprStart = wrapper.open;
		exprEnd = wrapper.end;
	}
	const j = afterGap(stripped, exprEnd);
	const site = (
		key: string,
		keyExpr: string,
		kind: EnvWriteKind,
		keyEnd: number,
		form: Site["form"] = "member",
	): Site => ({
		key,
		kind,
		line: lineOf(stripped, at),
		start: at,
		keyExpr,
		keyEnd,
		form,
	});
	const access = memberAccessAt(stripped, exprEnd);
	if (access?.kind === "dot") {
		const nameAt = nextNonSpace(stripped, access.at + 1);
		const name = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(nameAt))?.[0];
		if (name === undefined)
			return site(WHOLE_ENV, "", "unclassified", access.at, "whole");
		const after = nextNonSpace(stripped, nameAt + name.length);
		if (deleted) return site(name, name, "delete", after);
		if (assignmentAt(stripped, after) >= 0)
			return site(name, name, "assign", after);
		// A property read — unless the whole member chain is an assignment
		// target (`({ x: process.env.A } = …)`), which writes it.
		return inAssignmentTarget(stripped, at)
			? site(name, name, "unclassified", after)
			: undefined;
	}
	if (access?.kind === "bracket") {
		const close = matchingCloseIndex(stripped, access.at, "[", "]");
		if (close < 0)
			return site(WHOLE_ENV, "", "unclassified", access.at, "whole");
		const keyExpr = scan.raw.slice(access.at + 1, close).trim();
		const key = normalizeKey(keyExpr);
		if (deleted) return site(key, keyExpr, "delete", close + 1);
		if (assignmentAt(stripped, close + 1) >= 0)
			return site(key, keyExpr, "assign", close + 1);
		return inAssignmentTarget(stripped, at)
			? site(key, keyExpr, "unclassified", close + 1)
			: undefined;
	}
	if (deleted) return site(WHOLE_ENV, "", "delete", j, "whole");
	if (assignmentAt(stripped, j) >= 0)
		return site(WHOLE_ENV, "", "assign", j, "whole");
	const after = stripped[j];
	if (after === undefined || after === "=" || READ_FOLLOW.has(after))
		return undefined;
	if (READ_KEYWORD.test(stripped.slice(j))) return undefined;
	return site(WHOLE_ENV, "", "unclassified", j, "whole");
}

/**
 * Every env write in one file's blanked source, INCLUDING the teardown writes
 * that restore them — the caller needs both to decide coverage.
 */
function envWriteSites(scan: Scan): Site[] {
	const { stripped } = scan;
	const { members, objects } = seamRefs(stripped);
	const sites: Site[] = [];
	for (const ref of members) {
		const site = siteFromRef(scan, ref.at, ref.end);
		if (site !== undefined) sites.push(site);
	}
	for (const match of stripped.matchAll(STUB_ENV)) {
		const at = match.index ?? 0;
		const paren = at + match[0].length - 1;
		const close = matchingCloseIndex(stripped, paren, "(", ")");
		if (close < 0) continue;
		const keyExpr = argumentAt(scan, paren, close, 0);
		sites.push({
			key: normalizeKey(keyExpr),
			kind: "stub",
			line: lineOf(stripped, at),
			start: at,
			keyExpr,
			keyEnd: close,
			form: "stub",
		});
	}
	sites.push(...mutatorSites(scan, objects));
	return sites.sort((a, b) => a.start - b.start);
}

/** Offset ranges of every function body, from one brace walk. */
function functionBodies(stripped: string): Range[] {
	const bodies: Range[] = [];
	const open: number[] = [];
	for (let i = 0; i < stripped.length; i++) {
		if (stripped[i] === "{") open.push(i);
		else if (stripped[i] === "}") {
			const start = open.pop();
			if (start !== undefined && isFunctionBrace(stripped, start))
				bodies.push({ start: start + 1, end: i });
		}
	}
	return bodies;
}

function innermost(ranges: readonly Range[], index: number): Range | undefined {
	let best: Range | undefined;
	for (const range of ranges) {
		if (index <= range.start || index >= range.end) continue;
		if (best === undefined || range.end - range.start < best.end - best.start)
			best = range;
	}
	return best;
}

/** Function body range containing `index`, or the whole file at file scope. */
function ownerOf(
	stripped: string,
	bodies: readonly Range[],
	index: number,
): Range {
	return innermost(bodies, index) ?? { start: 0, end: stripped.length };
}

function inside(ranges: readonly Range[], index: number): boolean {
	return ranges.some((range) => index > range.start && index < range.end);
}

/**
 * The body of the declaration call whose identifier ends at `identifierEnd`,
 * walking its modifier chain (`describe.skipIf(cond)(`, `it.each(t)(`).
 * Returns undefined when the declaration is not an inline body.
 */
function declarationBody(
	stripped: string,
	identifierEnd: number,
): Range | undefined {
	let i = identifierEnd;
	let modifier = "";
	for (;;) {
		i = nextNonSpace(stripped, i);
		if (i >= stripped.length) return undefined;
		const ch = stripped[i];
		if (ch === ".") {
			const start = nextNonSpace(stripped, i + 1);
			let end = start;
			while (end < stripped.length && /[\w$]/.test(stripped[end])) end++;
			if (end === start) return undefined;
			modifier = stripped.slice(start, end);
			i = end;
			continue;
		}
		if (ch === "`" && ARGUMENT_TAKING_MODIFIERS.has(modifier)) {
			const close = stripped.indexOf("`", i + 1);
			if (close < 0) return undefined;
			modifier = "";
			i = close + 1;
			continue;
		}
		if (ch !== "(") return undefined;
		const close = matchingCloseIndex(stripped, i, "(", ")");
		if (close < 0) return undefined;
		if (ARGUMENT_TAKING_MODIFIERS.has(modifier)) {
			modifier = "";
			i = close + 1;
			continue;
		}
		const brace = callbackBodyBrace(stripped, i, close);
		if (brace < 0) {
			// A concise arrow body (`afterEach(() => resetEnv())`): the
			// expression is what runs, so its call is the region.
			const arrow = stripped.indexOf("=>", i);
			if (arrow < 0 || arrow > close) return undefined;
			return { start: arrow + 2, end: close };
		}
		const end = matchingCloseIndex(stripped, brace, "{", "}");
		if (end < 0) return undefined;
		return { start: brace + 1, end };
	}
}

/** Offset ranges of every `describe(...)` callback body. */
function describeBodies(stripped: string): Range[] {
	const ranges: Range[] = [];
	for (const match of stripped.matchAll(DESCRIBE)) {
		const body = declarationBody(
			stripped,
			(match.index ?? 0) + match[0].length,
		);
		if (body !== undefined) ranges.push(body);
	}
	return ranges;
}

/** The `describe` chain containing `index`, outermost first. */
function describeChain(describes: readonly Range[], index: number): Range[] {
	return describes
		.filter((range) => index > range.start && index < range.end)
		.sort((a, b) => a.start - b.start);
}

/** Does the teardown's chain cover a write made at `inner`? */
function chainCovers(
	outer: readonly Range[],
	inner: readonly Range[],
): boolean {
	if (outer.length > inner.length) return false;
	return outer.every(
		(range, i) => range.start === inner[i].start && range.end === inner[i].end,
	);
}

/** Offset ranges of every `finally { … }` block. */
function finallyBodies(stripped: string): Range[] {
	const ranges: Range[] = [];
	for (const match of stripped.matchAll(/(?<![\w$])finally\s*\{/g)) {
		const at = match.index ?? 0;
		const brace = at + match[0].length - 1;
		const end = matchingCloseIndex(stripped, brace, "{", "}");
		if (end < 0) continue;
		ranges.push({ start: brace + 1, end });
	}
	return ranges;
}

/**
 * The `{` opening a function body at or after `from`, skipping an object-shaped
 * return type annotation on the way, or -1.
 */
function bodyBraceFrom(stripped: string, from: number): number {
	for (let i = from; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "{") {
			if (isFunctionBrace(stripped, i)) return i;
			const close = matchingCloseIndex(stripped, i, "{", "}");
			if (close < 0) return -1;
			i = close;
			continue;
		}
		if (ch === ";" || ch === "}") return -1;
	}
	return -1;
}

/** One file-local function declaration: its body and its parameter names. */
interface LocalFunction {
	body: Range;
	params: string[];
}

/**
 * Every function this file declares, keyed by name. An imported helper is not
 * here, so a teardown that calls one gets no restore from it (fail closed).
 */
function localFunctions(scan: Scan): Map<string, LocalFunction> {
	const { stripped } = scan;
	const found = new Map<string, LocalFunction>();
	/** Two declarations of one name in different scopes: only one body can run. */
	const ambiguous = new Set<string>();
	const patterns = [
		/(?<![\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
		/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?\(/g,
	];
	for (const pattern of patterns) {
		for (const match of stripped.matchAll(pattern)) {
			const name = match[1];
			if (name === undefined || ambiguous.has(name)) continue;
			if (found.has(name)) {
				found.delete(name);
				ambiguous.add(name);
				continue;
			}
			const paren = (match.index ?? 0) + match[0].length - 1;
			const close = matchingCloseIndex(stripped, paren, "(", ")");
			if (close < 0) continue;
			// The body is the next function brace, past a `: void` annotation.
			const brace = bodyBraceFrom(stripped, close + 1);
			if (brace < 0) continue;
			const end = matchingCloseIndex(stripped, brace, "{", "}");
			if (end < 0) continue;
			found.set(name, {
				body: { start: brace + 1, end },
				params: stripped
					.slice(paren + 1, close)
					.split(",")
					.map((param) => /^[A-Za-z_$][\w$]*/.exec(param.trim())?.[0])
					.filter((param): param is string => param !== undefined),
			});
		}
	}
	return found;
}

/** The enclosing group of `index`, innermost first, or the whole file. */
function innermostScope(stripped: string, index: number): Range {
	let best: Range | undefined;
	const stack: number[] = [];
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "{" || ch === "(" || ch === "[") stack.push(i);
		else if (ch === "}" || ch === ")" || ch === "]") {
			const start = stack.pop();
			if (start === undefined) continue;
			if (!(start < index && index < i)) continue;
			if (best === undefined || i - start < best.end - best.start)
				best = { start, end: i };
		}
	}
	return best ?? { start: 0, end: stripped.length };
}

/**
 * Index of the value after `const <name> =`, resolved in the READER's scope:
 * the innermost declaration whose block or function body holds `at`, so two
 * suites that each declare `ENV_KEYS` do not answer for each other.
 */
function declarationInitializer(
	stripped: string,
	at: number,
	name: string,
): number {
	let best: { init: number; size: number } | undefined;
	let before: number | undefined;
	for (const match of stripped.matchAll(DECLARATION)) {
		const declAt = match.index ?? 0;
		const afterKeyword = nextNonSpace(stripped, declAt + match[0].length);
		const declared = /^[A-Za-z_$][\w$]*/.exec(
			stripped.slice(afterKeyword),
		)?.[0];
		if (declared !== name) continue;
		let i = afterKeyword + declared.length;
		// A type annotation cannot contain `=`; a `;` ends the statement.
		while (i < stripped.length && stripped[i] !== "=" && stripped[i] !== ";")
			i++;
		if (stripped[i] !== "=") continue;
		const init = nextNonSpace(stripped, i + 1);
		if (init < at && (before === undefined || init > before)) before = init;
		const scope = innermostScope(stripped, declAt);
		if (!(scope.start < at && at < scope.end)) continue;
		const size = scope.end - scope.start;
		if (best === undefined || size < best.size) best = { init, size };
	}
	return best?.init ?? before ?? -1;
}

/** Does an object literal at `open` copy the whole environment (`...`) ? */
function spreadAll(scan: Scan, open: number, seen = 0): boolean {
	const close = matchingCloseIndex(scan.stripped, open, "{", "}");
	if (close < 0 || seen > 2) return false;
	const text = scan.stripped.slice(open, close + 1);
	if (
		/\.\.\.\s*(?:(?:globalThis|window|self|global)\s*\.\s*)?process\s*\.\s*env\b/.test(
			text,
		)
	)
		return true;
	const spread = /\.\.\.\s*([A-Za-z_$][\w$]*)\b/.exec(text)?.[1];
	if (spread === undefined) return false;
	const init = declarationInitializer(scan.stripped, open, spread);
	if (init < 0) return false;
	const next = nextNonSpace(scan.stripped, init);
	return scan.stripped[next] === "{" ? spreadAll(scan, next, seen + 1) : false;
}

/**
 * The keys of the value at `index`: an array literal's strings, an object
 * literal's property names, or the literal a bare identifier is initialized
 * from.
 */
function valueKeys(scan: Scan, at: number, index: number): string[] {
	if (index < 0) return [];
	const start = nextNonSpace(scan.stripped, index);
	if (scan.stripped[start] === "[") return arrayKeysAt(scan, start);
	if (scan.stripped[start] === "{") return objectKeysAt(scan, start);
	const name = /^[A-Za-z_$][\w$]*/.exec(scan.stripped.slice(start))?.[0];
	if (name === undefined) return [];
	return valueKeys(scan, at, declarationInitializer(scan.stripped, at, name));
}

/** Property names of the object literal opening at `open`. */
function objectKeysAt(scan: Scan, open: number): string[] {
	if (spreadAll(scan, open)) return [WHOLE_ENV];
	const close = matchingCloseIndex(scan.stripped, open, "{", "}");
	if (close < 0) return [];
	// Strings are KEPT so a quoted property name reads as a name; comments are
	// blanked, so a commented-out property contributes nothing.
	const kept = stripSource(scan.raw.slice(open, close + 1), {
		strings: "keep",
	});
	const names = [
		...kept.matchAll(
			/(?:^|[{,])\s*(?:([A-Za-z_$][\w$]*)|["'`]([^"'`]+)["'`])\s*:/gm,
		),
	].map((match) => match[1] ?? match[2]);
	return names.filter(
		(key): key is string => key !== undefined && key.length > 0,
	);
}

/** String literals inside the array literal opening at `open`. */
function arrayKeysAt(scan: Scan, open: number): string[] {
	const close = matchingCloseIndex(scan.stripped, open, "[", "]");
	if (close < 0) return [];
	return stringLiterals(scan.raw.slice(open + 1, close));
}

/** Every string literal value in `text`, read with comments blanked. */
function stringLiterals(text: string): string[] {
	const kept = stripSource(text, { strings: "keep" });
	return [...kept.matchAll(/["'`]([^"'`]*)['"`]/g)]
		.map((match) => match[1])
		.filter((key): key is string => key !== undefined && key.length > 0);
}

/** One `Object.entries|keys(RECORD)` loop head. */
interface RecordLoop {
	at: number;
	names: string[];
	record: string;
	kind: "entries" | "keys";
}

function recordLoops(stripped: string): RecordLoop[] {
	const loops: RecordLoop[] = [];
	for (const match of stripped.matchAll(RECORD_LOOP)) {
		const record = match[3];
		const kinds = match[2];
		if (record === undefined || kinds === undefined) continue;
		const names = (match[1] ?? "")
			.replace(/[[\]]/g, ",")
			.split(",")
			.map((part) => part.trim())
			.filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
		loops.push({
			at: match.index ?? 0,
			names,
			record,
			kind: kinds as "entries" | "keys",
		});
	}
	return loops;
}

/**
 * The keys a name-keyed RECORD restores: the literal's own keys, plus every
 * key assigned into it from a key-list loop (`for (const key of KEYS)
 * saved[key] = process.env[key]`).
 */
function recordKeys(scan: Scan, at: number, name: string): string[] {
	const keys = new Set(
		valueKeys(scan, at, declarationInitializer(scan.stripped, at, name)),
	);
	for (const match of scan.stripped.matchAll(
		/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\[/g,
	)) {
		if (match[1] !== name) continue;
		const bracket = (match.index ?? 0) + match[0].length - 1;
		const close = matchingCloseIndex(scan.stripped, bracket, "[", "]");
		if (close < 0) continue;
		const inner = scan.raw.slice(bracket + 1, close).trim();
		const literal = stringLiteral(inner);
		if (literal !== undefined) {
			if (literal) keys.add(literal);
			continue;
		}
		if (!/^[A-Za-z_$][\w$]*$/.test(inner)) continue;
		for (const key of loopIterableKeys(scan, at, inner)) keys.add(key);
	}
	return [...keys];
}

/** Keys the key-list loop binding `variable` iterates, or none. */
function loopIterableKeys(scan: Scan, at: number, variable: string): string[] {
	for (const match of scan.stripped.matchAll(KEY_LIST_LOOP)) {
		if (match[1] !== variable) continue;
		return valueKeys(scan, at, (match.index ?? 0) + match[0].length);
	}
	return [];
}

/** Offset of a declaration's initializer, or undefined when it has none. */
function declarationValue(stripped: string, from: number): number | undefined {
	let i = from;
	while (i < stripped.length && stripped[i] !== "=" && stripped[i] !== ";") i++;
	if (stripped[i] !== "=") return undefined;
	return nextNonSpace(stripped, i + 1);
}

/** End offset of the expression starting at `from` (its `;` or enclosing `}`). */
function expressionEnd(stripped: string, from: number): number {
	let depth = 0;
	for (let i = from; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			if (depth === 0) return i;
			depth--;
		} else if (ch === ";" && depth === 0) return i;
	}
	return stripped.length;
}

/**
 * Does the initializer at `init` read the environment? A literal does not: a
 * fixed default (`const DEFAULT = "0"`) restores nothing when a teardown
 * assigns it back, so it is not a saved value.
 */
function savedInitializer(
	scan: Scan,
	init: number,
	region: readonly Range[],
	seen: Set<string>,
): boolean {
	const { stripped } = scan;
	const text = stripped.slice(init, expressionEnd(stripped, init));
	if ([...text.matchAll(SEAM)].length > 0) return true;
	const name = /^[A-Za-z_$][\w$]*/.exec(text)?.[0];
	if (name === undefined) return false;
	return name !== "process" && isSavedName(scan, name, region, seen);
}

/** Does a name resolve to a value saved OUTSIDE the restore region? */
function isSavedName(
	scan: Scan,
	name: string,
	region: readonly Range[],
	seen: Set<string> = new Set(),
): boolean {
	if (seen.has(name) || seen.size > 8) return false;
	seen.add(name);
	const { stripped } = scan;
	for (const match of stripped.matchAll(DECLARATION)) {
		const declAt = match.index ?? 0;
		const afterKeyword = nextNonSpace(stripped, declAt + match[0].length);
		const declared = /^[A-Za-z_$][\w$]*/.exec(
			stripped.slice(afterKeyword),
		)?.[0];
		if (declared !== name) continue;
		// A value declared INSIDE the teardown or finally was never saved.
		if (inside(region, declAt)) continue;
		// Declared outside cleanup: saved only when it reads the environment
		// (or another saved value). `let originalFlag;` has no initializer and
		// is filled from `process.env` later, so it stays a saved value.
		const init = declarationValue(stripped, afterKeyword + declared.length);
		if (init === undefined) return true;
		if (savedInitializer(scan, init, region, seen)) return true;
	}
	// A loop binding: `for (const [key, value] of Object.entries(saved))`. The
	// bound value is saved when the record it destructures is.
	for (const loop of recordLoops(stripped)) {
		if (!loop.names.includes(name)) continue;
		if (isSavedName(scan, loop.record, region, seen)) return true;
	}
	return false;
}

/** The body range of a loop head ending at `headEnd` (a block or one statement). */
function loopBody(stripped: string, headEnd: number): Range {
	const at = nextNonSpace(stripped, headEnd);
	if (stripped[at] === "{") {
		const end = matchingCloseIndex(stripped, at, "{", "}");
		return { start: at, end: end < 0 ? stripped.length : end };
	}
	let i = at;
	let depth = 0;
	for (; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === ";" && depth === 0) break;
	}
	return { start: at, end: i };
}

/**
 * The loop bindings whose loops ENCLOSE `site`: a test that iterates a
 * declared key list writes `process.env[key]` for each of its literals, and a
 * teardown loop over the same list restores them by name. The binding is
 * resolved at its own loop head, so a sibling loop or an outer variable of the
 * same name cannot rename another site's key.
 */
function bindingsAt(scan: Scan, site: Site): Map<string, string[]> {
	const binds = new Map<string, { at: number; keys: string[] }>();
	const set = (name: string, at: number, keys: string[]): void => {
		// The INNERMOST enclosing loop wins: an outer loop of the same name is
		// shadowed at this site.
		const previous = binds.get(name);
		if (previous !== undefined && previous.at > at) return;
		binds.set(name, { at, keys });
	};
	const { stripped } = scan;
	for (const match of stripped.matchAll(KEY_LIST_LOOP)) {
		const variable = match[1];
		if (variable === undefined) continue;
		const at = match.index ?? 0;
		const headEnd = matchingCloseIndex(stripped, at, "(", ")");
		if (headEnd < 0) continue;
		if (!inside([loopBody(stripped, headEnd + 1)], site.start)) continue;
		set(variable, at, valueKeys(scan, at, at + match[0].length));
	}
	for (const loop of recordLoops(stripped)) {
		const headEnd = matchingCloseIndex(stripped, loop.at, "(", ")");
		if (headEnd < 0) continue;
		if (!inside([loopBody(stripped, headEnd + 1)], site.start)) continue;
		const keys = recordKeys(scan, loop.at, loop.record);
		for (const name of loop.names) set(name, loop.at, keys);
	}
	return new Map([...binds].map(([name, bind]) => [name, bind.keys]));
}

/** The keys a write names, with the loop it sits in resolved. */
function siteKeys(scan: Scan, site: Site): string[] {
	if (site.keyExpr === "") return [site.key];
	const bindings = new Map<string, string[]>();
	for (const [name, keys] of bindingsAt(scan, site))
		if (name === site.keyExpr) bindings.set(name, keys);
	if (bindings.size === 0) return [site.key];
	const keys = resolveKeyExpr(site.keyExpr, new Map(), bindings);
	return keys.length > 0 ? [...new Set(keys)] : [site.key];
}

/** Does a write's assigned value carry a value saved outside the region? */
function hasSavedValue(
	scan: Scan,
	operator: number,
	region: readonly Range[],
	params: ReadonlyMap<string, ParamBinding>,
): boolean {
	const at = nextNonSpace(scan.stripped, operator + 1);
	const root = /^[A-Za-z_$][\w$]*/.exec(scan.stripped.slice(at))?.[0];
	if (root === undefined) return false;
	const param = params.get(root);
	if (param !== undefined) return param.kind === "value" && param.saved;
	// `process.env.K = process.env.K` restores nothing: a live read is not a
	// saved value.
	if (root === "process") return false;
	return isSavedName(scan, root, region);
}

/** The keys a write's key expression names, once the region's bindings apply. */
function resolveKeyExpr(
	text: string,
	params: ReadonlyMap<string, ParamBinding>,
	bindings: ReadonlyMap<string, string[]>,
): string[] {
	const expr = text.trim();
	if (expr === "") return [WHOLE_ENV];
	const literal = stringLiteral(expr);
	if (literal !== undefined) return [literal || `<empty>${expr}`];
	if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return [normalizeKey(expr)];
	const param = params.get(expr);
	if (param !== undefined) return param.kind === "key" ? param.keys : [expr];
	const loop = bindings.get(expr);
	return loop ?? [normalizeKey(expr)];
}

/**
 * A whole-environment assignment restores only when its source is a value this
 * file saved OUTSIDE the region. `process.env = { ...process.env }` copies the
 * live environment back, and a fresh literal (`{ OTHER: "1" }`) is a write.
 */
function wholeEnvRestore(
	scan: Scan,
	site: Site,
	operator: number,
	region: readonly Range[],
): boolean {
	const init = nextNonSpace(scan.stripped, operator + 1);
	if (scan.stripped[init] !== "{") {
		const name = /^[A-Za-z_$][\w$]*/.exec(scan.stripped.slice(init))?.[0];
		if (name === undefined || !isSavedName(scan, name, region)) return false;
		const decl = declarationInitializer(scan.stripped, site.start, name);
		if (decl < 0) return false;
		return spreadAll(scan, nextNonSpace(scan.stripped, decl));
	}
	return savedSpreadOnly(scan, init, region);
}

/**
 * Does the object literal at `open` consist of ONE spread of a name saved
 * outside the region (`{ ...saved }`)? An extra property makes the literal a
 * write of its own, and a spread of a live expression copies live state.
 */
function savedSpreadOnly(
	scan: Scan,
	open: number,
	region: readonly Range[],
): boolean {
	const close = matchingCloseIndex(scan.stripped, open, "{", "}");
	if (close < 0) return false;
	const inner = stripSource(scan.raw.slice(open + 1, close)).trim();
	const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(inner);
	if (spread?.[1] === undefined) return false;
	return isSavedName(scan, spread[1], region);
}

/** Does this write put a saved value back, rather than leak one? */
function restoreShaped(
	scan: Scan,
	site: Site,
	params: ReadonlyMap<string, ParamBinding>,
	region: readonly Range[],
): boolean {
	if (site.kind === "delete") return true;
	if (site.kind !== "assign") return false;
	if (site.form === "mutator") {
		// A mutator copies a saved record back; a live read or a fresh literal
		// is not a restore.
		const value = site.valueExpr?.trim() ?? "";
		return value !== "" && argIsSaved(scan, value, region);
	}
	const operator = assignmentAt(scan.stripped, site.keyEnd);
	if (operator < 0) return false;
	if (site.keyExpr !== "") return hasSavedValue(scan, operator, region, params);
	return wholeEnvRestore(scan, site, operator, region);
}

/** One call's arguments, split at top level, as raw text. */
function splitArguments(scan: Scan, paren: number, close: number): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = paren + 1;
	for (let i = paren + 1; i < close; i++) {
		const ch = scan.stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			args.push(scan.raw.slice(start, i));
			start = i + 1;
		}
	}
	args.push(scan.raw.slice(start, close));
	return args;
}

/**
 * Is the argument expression (a name or a member of one) a value saved
 * outside the region? `previous.home` is saved when `previous` is.
 */
function argIsSaved(
	scan: Scan,
	arg: string,
	region: readonly Range[],
): boolean {
	const root = /^[A-Za-z_$][\w$]*/.exec(arg.trim())?.[0];
	if (root === undefined) return false;
	if (root === "process") return false;
	if (!/^[A-Za-z_$][\w$]*(?:\s*(?:\.|\[))?/.test(arg.trim())) return false;
	return isSavedName(scan, root, region);
}

/**
 * The file-local helpers a region body calls, one hop, each with its
 * parameters bound to that call's arguments.
 */
function inlinedPieces(
	scan: Scan,
	range: Range,
	functions: ReadonlyMap<string, LocalFunction>,
	region: readonly Range[],
): Piece[] {
	const pieces: Piece[] = [];
	const text = scan.stripped.slice(range.start, range.end);
	for (const match of text.matchAll(CALL_SITE)) {
		const name = match[1];
		if (name === undefined) continue;
		// Only a BARE call reaches a file-local function. `logger.restore()`
		// calls a method on another object, whose body this file cannot see.
		const nameAt =
			range.start + (match.index ?? 0) + match[0].lastIndexOf(name);
		let before = nameAt - 1;
		while (before >= 0 && /\s/.test(scan.stripped[before])) before--;
		if (scan.stripped[before] === ".") continue;
		const fn = functions.get(name);
		if (fn === undefined) continue;
		const paren = range.start + (match.index ?? 0) + match[0].length - 1;
		const close = matchingCloseIndex(scan.stripped, paren, "(", ")");
		if (close < 0) continue;
		const args = splitArguments(scan, paren, close);
		const params = new Map<string, ParamBinding>();
		fn.params.forEach((param, index) => {
			const arg = args[index]?.trim();
			if (arg === undefined || arg === "") return;
			const literal = stringLiteral(arg);
			if (literal !== undefined) {
				if (literal !== "") params.set(param, { kind: "key", keys: [literal] });
				return;
			}
			// Anything but a literal is a value: saved only when the root of its
			// own expression was declared outside the region.
			if (argIsSaved(scan, arg, region))
				params.set(param, { kind: "value", saved: true });
		});
		pieces.push({ range: fn.body, params });
	}
	return pieces;
}

/** Everything one teardown or `finally` region restores. */
function regionHits(
	scan: Scan,
	sites: readonly Site[],
	region: RestoreRegion,
): RestoreHit[] {
	const hits: RestoreHit[] = [];
	const pieceRanges = region.pieces.map((p) => p.range);
	for (const piece of region.pieces) {
		for (const site of sites) {
			if (site.start <= piece.range.start || site.start >= piece.range.end)
				continue;
			// A write inside a function DECLARED in the cleanup may never run:
			// `afterEach(() => { const unused = () => { delete process.env.K; }; })`
			// deletes nothing. Only a checked call reaches a body, and that body
			// is its own piece.
			if (insideNestedFunction(scan, piece.range, site.start)) continue;
			if (!restoreShaped(scan, site, piece.params, pieceRanges)) continue;
			for (const key of resolveKeyExpr(
				site.keyExpr,
				piece.params,
				bindingsAt(scan, site),
			))
				hits.push({ key, pos: site.start, scope: region.scope });
		}
		for (const match of scan.stripped
			.slice(piece.range.start, piece.range.end)
			.matchAll(UNSTUB_ENV))
			hits.push({
				key: "*",
				pos: piece.range.start + (match.index ?? 0),
				scope: region.scope,
			});
	}
	return hits;
}

/** Is `index` inside a function body declared strictly within `range`? */
function insideNestedFunction(
	scan: Scan,
	range: Range,
	index: number,
): boolean {
	return scan.bodies.some(
		(body) =>
			body.start > range.start &&
			body.end < range.end &&
			index > body.start &&
			index < body.end,
	);
}

/** Every teardown and `finally` region in the file, one hop expanded. */
function restoreRegions(
	scan: Scan,
	functions: ReadonlyMap<string, LocalFunction>,
): RestoreRegion[] {
	const { stripped } = scan;
	const describes = describeBodies(stripped);
	const regions: RestoreRegion[] = [];
	for (const match of stripped.matchAll(TEARDOWN)) {
		const at = match.index ?? 0;
		const body = declarationBody(stripped, at + match[0].length);
		if (body === undefined) continue;
		regions.push({
			scope: { kind: "teardown", chain: describeChain(describes, at) },
			pieces: [
				{ range: body, params: new Map() },
				...inlinedPieces(scan, body, functions, [body]),
			],
		});
	}
	for (const body of finallyBodies(stripped)) {
		regions.push({
			scope: {
				kind: "finally",
				owner: ownerOf(stripped, scan.bodies, body.start),
			},
			pieces: [
				{ range: body, params: new Map() },
				...inlinedPieces(scan, body, functions, [body]),
			],
		});
	}
	return regions;
}

/** Does `scope` run for `site`, once the restoring `hit` has run? */
function scopeCovers(
	scope: RestoreScope,
	site: Site,
	hitPos: number,
	scan: Scan,
	describes: readonly Range[],
): boolean {
	if (scope.kind === "teardown")
		return chainCovers(scope.chain, describeChain(describes, site.start));
	const owner = ownerOf(scan.stripped, scan.bodies, site.start);
	// A finally runs when its `try` finishes, so it cannot put back a write
	// made after it (`try {} finally { delete K } K = "leak"`); source order
	// inside one function is the whole ordering a finally body has.
	return (
		hitPos > site.start &&
		owner.start === scope.owner.start &&
		owner.end === scope.owner.end
	);
}

/**
 * Every env write in `source` that no accepted restore covers. `file` only
 * labels the findings; the detector reads nothing from disk.
 */
export function findUnrestoredEnvWrites(
	file: string,
	source: string,
): EnvRestoreFinding[] {
	const scan: Scan = {
		raw: source,
		stripped: stripSource(source, { strings: "blank" }),
		bodies: [],
	};
	scan.bodies = functionBodies(scan.stripped);
	const sites = envWriteSites(scan);
	if (sites.length === 0) return [];
	const describes = describeBodies(scan.stripped);
	const regions = restoreRegions(scan, localFunctions(scan));
	const hits: RestoreHit[] = [];
	/** Sites that ARE a restore, so they cannot also be the leak. */
	const restoring = new Set<number>();
	for (const region of regions) {
		for (const hit of regionHits(scan, sites, region)) {
			hits.push(hit);
			restoring.add(hit.pos);
		}
	}
	const findings: EnvRestoreFinding[] = [];
	for (const site of sites) {
		const keys = siteKeys(scan, site);
		for (const key of keys) {
			// A stub write is answered only by `vi.unstubAllEnvs()`, every other
			// write by its own key or by a whole-environment restore.
			const wanted = site.kind === "stub" ? "*" : key;
			const covered = hits.some(
				(hit) =>
					(hit.key === wanted ||
						(site.kind !== "stub" && hit.key === WHOLE_ENV)) &&
					hit.pos !== site.start &&
					scopeCovers(hit.scope, site, hit.pos, scan, describes),
			);
			if (covered || restoring.has(site.start)) continue;
			findings.push({
				file,
				key,
				kind: site.kind,
				line: site.line,
				start: site.start,
			});
		}
	}
	return findings;
}

/** Ranges of the callbacks passed to `vi.hoisted(...)`, read at module load. */
function hoistedBodies(stripped: string): Range[] {
	const ranges: Range[] = [];
	for (const match of stripped.matchAll(HOISTED)) {
		const paren = (match.index ?? 0) + match[0].length - 1;
		const close = matchingCloseIndex(stripped, paren, "(", ")");
		if (close < 0) continue;
		const brace = callbackBodyBrace(stripped, paren, close);
		if (brace < 0) continue;
		const end = matchingCloseIndex(stripped, brace, "{", "}");
		if (end < 0) continue;
		ranges.push({ start: brace + 1, end });
	}
	return ranges;
}

/** A write no per-case hook can reach: module scope, or a `vi.hoisted` body. */
function modulePinned(
	scan: Scan,
	hoisted: readonly Range[],
	index: number,
): boolean {
	// A write inside any group runs when that group's code runs; only a write
	// at module scope (outside every `{}`, `()` and `[]`) or in a `vi.hoisted`
	// callback is pinned before the suite starts.
	return (
		inside(hoisted, index) || innermostScope(scan.stripped, index).start === 0
	);
}

/** How a file can restore a key without the detector crediting the write. */
export type EnvRestoreMechanism =
	| "teardown"
	| "finally"
	| "helper"
	| "module-pin"
	| "none";

/**
 * The admission mechanisms `source` supports for `findings`, derived from the
 * same structure the detector reads. `module-pin` covers a write no per-case
 * hook can reach (module scope, or a `vi.hoisted` callback), so such a write
 * cannot be admitted as `teardown`, `finally` or `helper`. `none` is offered
 * only when the file declares no restore mechanism at all, which is the strong
 * claim a real leak makes.
 */
export function envRestoreMechanisms(
	source: string,
	findings: readonly EnvRestoreFinding[],
): EnvRestoreMechanism[] {
	const scan: Scan = {
		raw: source,
		stripped: stripSource(source, { strings: "blank" }),
		bodies: [],
	};
	scan.bodies = functionBodies(scan.stripped);
	const hoisted = hoistedBodies(scan.stripped);
	const pinned = findings.filter((finding) =>
		modulePinned(scan, hoisted, finding.start),
	).length;
	const inFunction = findings.length - pinned;
	const { stripped } = scan;
	const hasTeardown = /after(Each|All)\s*\(/.test(stripped);
	const hasFinally = /finally\s*\{/.test(stripped);
	const hasHelper = /return\s*\(\s*\)\s*=>|withEnv\s*\(|pinTestHome\s*\(/.test(
		stripped,
	);
	const hasUnstub = /unstubAllEnvs/.test(stripped);
	const hasStub = findings.some((finding) => finding.kind === "stub");
	const mechanisms: EnvRestoreMechanism[] = [];
	if (pinned > 0) mechanisms.push("module-pin");
	if (inFunction > 0) {
		if (hasTeardown && (!hasStub || hasUnstub)) mechanisms.push("teardown");
		if (hasFinally) mechanisms.push("finally");
		if (hasHelper) mechanisms.push("helper");
		// `none` is the strong claim that nothing puts this key back: a stub
		// needs no `vi.unstubAllEnvs` anywhere, a plain write no hook, finally,
		// or returned restore closure at all.
		if (hasStub ? !hasUnstub : !hasTeardown && !hasFinally && !hasHelper)
			mechanisms.push("none");
	}
	return mechanisms;
}

/**
 * The ratchet key: one row per file and environment key, never per line. A
 * computed key is escaped so the row is always whitespace-free, which is what
 * the admission guard requires — including a row `npm run test:regen` writes
 * for `process.env["A_" + "B"]`.
 */
export function envRestoreKey(finding: EnvRestoreFinding): string {
	return `${finding.file}:${escapeRowKey(finding.key)}`;
}

/** Escape whitespace and `%` so a row is one token; a `%` in a key round-trips. */
export function escapeRowKey(key: string): string {
	return key.replace(/[\s%]/g, (ch) => {
		const code = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase();
		return `%${code.padStart(2, "0")}`;
	});
}
