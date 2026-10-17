/**
 * #4589: unrestored `process.env` writes in test source.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * assigns or deletes an environment variable and nothing puts it back, so the
 * NEXT case in the same worker inherits the value. Recurrences #4563
 * (session-scope state) and #4586 (a log assertion that never read the real
 * sink) are the two this detector's own tests name.
 *
 * The detector is pure and takes one file's raw source. It reads the
 * comment- and string-BLANKED text (`stripSource`), so a needle quoted in a
 * comment or inside a fixture string is not a write (principles §2,
 * "detectors match code, not prose"), and reads VALUES back out of the raw
 * source at the offsets the blanked text reported, because `stripSource`
 * preserves length.
 *
 * An accepted restore is one of exactly five shapes, each decided from
 * structure and then valued from raw text:
 *
 * 1. an `afterEach`/`afterAll` callback assigning or deleting the same key;
 * 2. a teardown `for (const key of ENV_KEYS) delete process.env[key]` loop,
 *    resolved to the string literals of that array initializer;
 * 3. a teardown helper call carrying the key and a saved value,
 *    `restore("PI_LENS_HOME", saved)` — one assign away from shape 1;
 * 4. `vi.stubEnv(...)` paired with `vi.unstubAllEnvs()`;
 * 5. a `finally` block in the SAME enclosing function as the write.
 *
 * Anything else is a finding and belongs in the baseline. The detector never
 * accepts a shape it cannot read (a computed key, a concise arrow teardown
 * whose helper body sits outside the teardown, a helper the teardown calls
 * but whose env write the file does not resolve in place, a one-argument
 * call that merely names the key, a `finally` in another function): it
 * reports the write instead, the direction that keeps a leak a red rather
 * than a silent pass (AGENTS.md shape 69). That is why some baseline rows sit
 * in files that DO put their keys back: the row means "this write is not
 * provably restored here", and it shrinks when the file is made readable.
 * Writes the detector cannot see at all — a `withEnv({ … })` helper that
 * assigns from an object literal — are outside this rule's population; it
 * decides direct `process.env` writes, which is the shape the audit found.
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
export type EnvWriteKind = "assign" | "delete" | "stub";

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

/** One place that puts a key back, and where it lives. */
interface RestoreHit {
	/** The environment key restored, or `*` for every `vi.stubEnv` key. */
	key: string;
	/** Offset of the restoring site. */
	pos: number;
	/** True when the site runs in an `afterEach`/`afterAll` callback. */
	teardown: boolean;
	/** Enclosing function body, for the "same function" `finally` rule. */
	owner: Range;
}

/** One file's blanked text, raw text and brace-derived ranges. */
interface Scan {
	raw: string;
	stripped: string;
	bodies: Range[];
}

/**
 * A key written through an expression the detector cannot read statically. It
 * keeps its own name — `ENV_REVIEW_GRAPH_MAX` for a bare identifier — so the
 * same variable's write and restore still match, and so a baseline row is
 * stable across line moves.
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

function afterGap(stripped: string, index: number): number {
	let i = index;
	while (i < stripped.length && /[ \t]/.test(stripped[i])) i++;
	return i;
}

/**
 * Is the token after `from` an assignment operator? `==`, `===`, `=>`, `!=`,
 * `<=` and `>=` are comparisons, and `+=`, `||=` and `??=` are writes like `=`
 * is.
 */
const ASSIGN_OPERATOR = /^(?:\+|\|\||\?\?)?=(?!=|>)/;

function isAssignmentAfter(stripped: string, from: number): boolean {
	const at = afterGap(stripped, from);
	return ASSIGN_OPERATOR.test(stripped.slice(at, at + 4));
}

/** Offset of the top-level `,` ending the call's first argument, or -1. */
function firstArgumentEnd(
	stripped: string,
	paren: number,
	close: number,
): number {
	let depth = 0;
	for (let i = paren + 1; i < close; i++) {
		const ch = stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) return i;
	}
	return -1;
}

/** The raw text of a call's first argument. */
function firstArgument(
	stripped: string,
	raw: string,
	paren: number,
	close: number,
): string {
	const end = firstArgumentEnd(stripped, paren, close);
	return raw.slice(paren + 1, end < 0 ? close : end);
}

const DOT_ENV = /(?<![\w$.])process\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/g;
const BRACKET_ENV = /(?<![\w$.])process\s*\.\s*env\s*\[/g;
const WHOLE_ENV = /(?<![\w$.])process\s*\.\s*env\s*=(?!=)/g;
const STUB_ENV = /(?<![\w$.])vi\s*\.\s*stubEnv\s*\(/g;
const UNSTUB_ENV = /(?<![\w$.])vi\s*\.\s*unstubAllEnvs\s*\(/g;
const TEARDOWN = /(?<![\w$.])(?:afterEach|afterAll)(?![\w$])/g;
const KEY_LIST_LOOP =
	/(?<![\w$.])for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g;
/** `for (const [k, v] of Object.entries(RECORD))` and its `Object.keys` twin. */
const RECORD_LOOP =
	/(?<![\w$.])for\s*\(\s*(?:const|let|var)\s*(?:\[\s*([A-Za-z_$][\w$]*)[^\]]*\]|([A-Za-z_$][\w$]*))\s+of\s+Object\s*\.\s*(?:entries|keys)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;
const IDENT_BRACKET = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\[/g;
const CALL_SITE =
	/(?<![\w$])(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*\s*\(/g;
const DECLARATION = /(?<![\w$.])(?:const|let|var)\s+/g;

/**
 * Every env write in one file's blanked source, INCLUDING the teardown writes
 * that restore them — the caller needs both to decide coverage.
 */
export function envWriteSites(raw: string, stripped: string): EnvWriteSite[] {
	const sites: EnvWriteSite[] = [];
	const push = (
		at: number,
		key: string,
		kind: EnvWriteKind,
		start = at,
	): void => {
		sites.push({ key, kind, line: lineOf(stripped, at), start });
	};
	for (const match of stripped.matchAll(WHOLE_ENV))
		push(match.index ?? 0, "<process.env>", "assign");
	const kindAfter = (index: number, at: number): EnvWriteKind | undefined =>
		isAssignmentAfter(stripped, index)
			? "assign"
			: precedingWord(stripped, at) === "delete"
				? "delete"
				: undefined;
	for (const match of stripped.matchAll(DOT_ENV)) {
		const at = match.index ?? 0;
		const key = match[1];
		if (key === undefined) continue;
		const kind = kindAfter(at + match[0].length, at);
		if (kind !== undefined) push(at, key, kind);
	}
	for (const match of stripped.matchAll(BRACKET_ENV)) {
		const at = match.index ?? 0;
		const open = at + match[0].length - 1;
		const close = matchingCloseIndex(stripped, open, "[", "]");
		if (close < 0) continue;
		const kind = kindAfter(close + 1, at);
		if (kind === undefined) continue;
		push(at, normalizeKey(raw.slice(open + 1, close)), kind);
	}
	for (const match of stripped.matchAll(STUB_ENV)) {
		const at = match.index ?? 0;
		const paren = at + match[0].length - 1;
		const close = matchingCloseIndex(stripped, paren, "(", ")");
		if (close < 0) continue;
		push(at, normalizeKey(firstArgument(stripped, raw, paren, close)), "stub");
	}
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

/** Callback-body ranges of every `afterEach`/`afterAll` in the file. */
function teardownBodies(stripped: string): Range[] {
	const ranges: Range[] = [];
	for (const match of stripped.matchAll(TEARDOWN)) {
		const at = match.index ?? 0;
		const paren = afterGap(stripped, at + match[0].length);
		if (stripped[paren] !== "(") continue;
		const close = matchingCloseIndex(stripped, paren, "(", ")");
		if (close < 0) continue;
		// A concise arrow body (`afterEach(() => resetEnv())`) names its restore
		// in a helper this file-level scan cannot read; the write stays a
		// finding, the fail-closed direction.
		const brace = callbackBodyBrace(stripped, paren, close);
		if (brace < 0) continue;
		const end = matchingCloseIndex(stripped, brace, "{", "}");
		if (end < 0) continue;
		ranges.push({ start: brace + 1, end });
	}
	return ranges;
}

/** Offset ranges of every `finally { … }` block. */
function finallyBodies(stripped: string): Range[] {
	const ranges: Range[] = [];
	for (const match of stripped.matchAll(/(?<![\w$])finally\s*\{/g)) {
		const at = match.index ?? 0;
		const brace = at + match[0].length - 1;
		const end = matchingCloseIndex(stripped, brace, "{", "}");
		if (end < 0) continue;
		ranges.push({ start: brace, end });
	}
	return ranges;
}

/** Does `index` sit in a teardown body, or in a `finally` of `owner`? */
function inRestoreContext(
	scan: Scan,
	index: number,
	teardowns: readonly Range[],
	finallies: readonly Range[],
): boolean {
	if (inside(teardowns, index)) return true;
	const owner = ownerOf(scan.stripped, scan.bodies, index);
	return finallies.some(
		(range) =>
			index > range.start &&
			index < range.end &&
			sameOwner(scan, range.start, owner),
	);
}

function sameOwner(scan: Scan, index: number, owner: Range): boolean {
	const other = ownerOf(scan.stripped, scan.bodies, index);
	return other.start === owner.start && other.end === owner.end;
}

/**
 * The keys of the value starting at `index`: an array literal's strings, an
 * object literal's property names, or the literal a bare identifier is
 * initialized from. Read from raw text through a comments-blanked,
 * strings-KEPT copy of the same slice, so a key quoted in a comment
 * contributes nothing and offsets still line up with the file.
 */
function valueKeys(scan: Scan, index: number): string[] {
	if (index < 0) return [];
	const start = nextNonSpace(scan.stripped, index);
	if (scan.stripped[start] === "[") return arrayKeysAt(scan, start);
	if (scan.stripped[start] === "{") return objectKeysAt(scan, start);
	const name = /^[A-Za-z_$][\w$]*/.exec(scan.stripped.slice(start))?.[0];
	if (name === undefined) return [];
	return valueKeys(scan, declarationInitializer(scan.stripped, name));
}

/** Property names of the object literal opening at `open`. */
function objectKeysAt(scan: Scan, open: number): string[] {
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

/** Index of the value after `const <name> =`, or -1 when the file has none. */
function declarationInitializer(stripped: string, name: string): number {
	for (const match of stripped.matchAll(DECLARATION)) {
		const afterKeyword = nextNonSpace(
			stripped,
			(match.index ?? 0) + match[0].length,
		);
		const declared = /^[A-Za-z_$][\w$]*/.exec(
			stripped.slice(afterKeyword),
		)?.[0];
		if (declared !== name) continue;
		let i = afterKeyword + declared.length;
		// A type annotation cannot contain `=`; a `;` ends the statement.
		while (i < stripped.length && stripped[i] !== "=" && stripped[i] !== ";")
			i++;
		if (stripped[i] !== "=") continue;
		return nextNonSpace(stripped, i + 1);
	}
	return -1;
}

/**
 * The keys a name-keyed RECORD restores: the literal's own keys, plus every
 * key assigned into it from a key-list loop (`for (const key of KEYS)
 * saved[key] = process.env[key]`).
 */
function recordKeys(scan: Scan, name: string): string[] {
	const keys = new Set(
		valueKeys(scan, declarationInitializer(scan.stripped, name)),
	);
	for (const match of scan.stripped.matchAll(IDENT_BRACKET)) {
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
		for (const key of loopIterableKeys(scan, inner)) keys.add(key);
	}
	return [...keys];
}

/** Keys the key-list loop binding `variable` iterates, or none. */
function loopIterableKeys(scan: Scan, variable: string): string[] {
	for (const match of scan.stripped.matchAll(KEY_LIST_LOOP)) {
		if (match[1] !== variable) continue;
		return valueKeys(scan, (match.index ?? 0) + match[0].length);
	}
	return [];
}

/**
 * Keys a restore context puts back WITHOUT naming them in a
 * `process.env.X =` statement: a key-list loop, a loop over a saved-value
 * record, and a naming helper call that carries a saved value.
 */
function namedRestoreHits(
	scan: Scan,
	sites: readonly EnvWriteSite[],
	ranges: readonly Range[],
): Array<{ key: string; pos: number }> {
	const hits: Array<{ key: string; pos: number }> = [];
	const writesThrough = (variable: string, from: number, to: number): boolean =>
		sites.some(
			(site) => site.start > from && site.start < to && site.key === variable,
		);
	for (const range of ranges) {
		const text = scan.stripped.slice(range.start, range.end);
		for (const match of text.matchAll(KEY_LIST_LOOP)) {
			const at = range.start + (match.index ?? 0);
			const variable = match[1];
			if (variable === undefined) continue;
			const headClose = matchingCloseIndex(scan.stripped, at, "(", ")");
			if (headClose < 0) continue;
			// The loop must write through its own variable, or the array is a
			// read (`expect(keys).toContain(…)`) and restores nothing.
			if (!writesThrough(variable, headClose, range.end)) continue;
			for (const key of valueKeys(scan, at + match[0].length))
				hits.push({ key, pos: at });
		}
		for (const match of text.matchAll(RECORD_LOOP)) {
			const at = range.start + (match.index ?? 0);
			const variable = match[1] ?? match[2];
			const record = match[3];
			if (variable === undefined || record === undefined) continue;
			if (!writesThrough(variable, at, range.end)) continue;
			for (const key of recordKeys(scan, record)) hits.push({ key, pos: at });
		}
		for (const match of text.matchAll(CALL_SITE)) {
			const at = range.start + (match.index ?? 0);
			const paren = afterGap(scan.stripped, at + match[0].length - 1);
			if (scan.stripped[paren] !== "(") continue;
			const close = matchingCloseIndex(scan.stripped, paren, "(", ")");
			if (close < 0 || close > range.end) continue;
			// A second argument is what makes the call a restore:
			// `restore("K", saved)` carries the value to put back, `log("K")` does
			// not.
			if (firstArgumentEnd(scan.stripped, paren, close) < 0) continue;
			const key = stringLiteral(
				firstArgument(scan.stripped, scan.raw, paren, close).trim(),
			);
			if (key === undefined || key === "") continue;
			hits.push({ key, pos: at });
		}
	}
	return hits;
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
	const sites = envWriteSites(scan.raw, scan.stripped);
	if (sites.length === 0) return [];
	const teardowns = teardownBodies(scan.stripped);
	const finallies = finallyBodies(scan.stripped);
	const hit = (key: string, pos: number): RestoreHit => ({
		key,
		pos,
		teardown: inside(teardowns, pos),
		owner: ownerOf(scan.stripped, scan.bodies, pos),
	});
	const restoreHits: RestoreHit[] = [];
	for (const site of sites)
		if (
			site.kind !== "stub" &&
			inRestoreContext(scan, site.start, teardowns, finallies)
		)
			// `process.env = { …ORIGINAL }` in a teardown puts EVERY key back,
			// so it answers for each named write as well as for its own key.
			restoreHits.push(hit(site.key, site.start));
	for (const named of namedRestoreHits(scan, sites, [
		...teardowns,
		...finallies,
	]))
		restoreHits.push(hit(named.key, named.pos));
	for (const match of scan.stripped.matchAll(UNSTUB_ENV))
		restoreHits.push(hit("*", match.index ?? 0));

	const findings: EnvRestoreFinding[] = [];
	for (const site of sites) {
		if (inRestoreContext(scan, site.start, teardowns, finallies)) continue;
		const owner = ownerOf(scan.stripped, scan.bodies, site.start);
		const wanted = site.kind === "stub" ? "*" : site.key;
		const restored = restoreHits.some((restore) => {
			if (restore.pos === site.start) return false;
			// A whole-env restore answers for every named key; a `vi.stubEnv`
			// write is answered only by `vi.unstubAllEnvs`, because the stub
			// bookkeeping is Vitest's, not the variable's value.
			const matchesKey =
				restore.key === wanted ||
				(site.kind !== "stub" && restore.key === "<process.env>");
			if (!matchesKey) return false;
			if (restore.teardown) return true;
			return (
				restore.pos > site.start &&
				restore.owner.start === owner.start &&
				restore.owner.end === owner.end
			);
		});
		if (!restored) findings.push({ file, ...site });
	}
	return findings;
}

/** The ratchet key: one row per file and environment key, never per line. */
export function envRestoreKey(finding: EnvRestoreFinding): string {
	return `${finding.file}:${finding.key}`;
}
