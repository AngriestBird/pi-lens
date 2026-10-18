/**
 * The one reader of vitest's `shuffle` suite option (#4561 D1).
 *
 * A `describe` whose subject IS the order its cases run in opts out with
 * `{ shuffle: false }` and is registered in `scripts/shuffle-census-ratchet.json`
 * (`byDesign`). The registry is only worth having if a reader sees EVERY
 * spelling of the option, so this module fails closed: it admits exactly one
 * literal — an options object that sets only the bare `shuffle` key to
 * `false`, passed directly to a `describe` that vitest runs — and reports
 * everything else it cannot attribute. That covers a quoted key, a computed
 * key, another value, an options object with extra options or a spread, an
 * options object bound in another module, and an opt-out whose suite a skip
 * modifier (or an enclosing skipped suite) keeps from running.
 *
 * Review r1 (#4611): the first version read a fixed set of syntactic
 * spellings off `stripSource`'s blanked text, so a quoted key was invisible
 * (the string was blanked), an options object imported from a support module
 * was never read at all, and a plant of each left the suite green. Structure
 * now comes from the call itself; a key census over the comment-blanked,
 * string-preserving view is the net behind it.
 */
import {
	lineOf,
	matchingCloseIndex,
	stripSource,
	testDeclarations,
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

/**
 * A property-position `shuffle` key in any spelling: bare, quoted, or
 * computed. `strings: "keep"` is what makes the quoted and computed forms
 * visible at all; requiring `{` or `,` before it keeps a test title or a
 * message that happens to say the word out of the census.
 */
const KEY =
	/(?<=[{,])\s*(?:\bshuffle\b|(["'`])shuffle\1|\[\s*(["'`])shuffle\2\s*\])\s*:/g;

/** The admitted options object, as `stripSource` leaves it (strings blanked). */
const ADMITTED = /^shuffle\s*:\s*false$/;

/**
 * A computed key in property position. Its NAME is a value this reader cannot
 * resolve, so an opt-out written that way is unattributable whatever the
 * variable it reads happens to hold, and whatever the file spells elsewhere.
 */
const COMPUTED_KEY = /(?:^|[{,])\s*\[/;

/** An argument that is a callback, not an options object. */
const CALLBACK = /^(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>)/;

/** The top-level argument spans of a call, trimmed, on the stripped source. */
function argumentSpans(
	code: string,
	callParen: number,
	callEnd: number,
): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let start = callParen + 1;
	let depth = 0;
	for (let i = callParen + 1; i <= callEnd; i++) {
		const atEnd = i === callEnd;
		const ch = code[i];
		const separator = depth === 0 && ch === ",";
		if (atEnd || separator) {
			let a = start;
			let b = i;
			while (a < b && /\s/.test(code[a] as string)) a++;
			while (b > a && /\s/.test(code[b - 1] as string)) b--;
			if (a < b) spans.push([a, b]);
			start = i + 1;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
	}
	return spans;
}

/** Index of a property-position `shuffle` key between `open` and `close`. */
function shuffleKeyBetween(
	text: string,
	open: number,
	close: number,
): number | undefined {
	const slice = text.slice(open, close + 1);
	const match = new RegExp(KEY.source, "g").exec(slice);
	if (match === null) return undefined;
	return open + (match.index ?? 0);
}

/** The admitted spelling, or why this options object is not it. */
function optionsVerdict(
	inner: string,
	keyPresent: boolean,
): { admitted: boolean; reason: string } {
	if (COMPUTED_KEY.test(inner)) {
		return {
			admitted: false,
			reason:
				"its options hold a computed key, whose name this reader cannot resolve, so an opt-out behind it is unattributable",
		};
	}
	if (!keyPresent) {
		if (inner.includes("...")) {
			return {
				admitted: false,
				reason:
					"its options spread another object, so a shuffle opt-out carried in that object is invisible here",
			};
		}
		return { admitted: true, reason: "" };
	}
	if (inner.includes("...")) {
		return {
			admitted: false,
			reason:
				"its options spread another object beside a shuffle key, so which one wins is not readable here",
		};
	}
	const normalized = inner.replace(/\s+/g, " ").trim().replace(/,$/, "").trim();
	return ADMITTED.test(normalized)
		? { admitted: true, reason: "" }
		: {
				admitted: false,
				reason:
					"the shuffle key is spelled in a form this census does not admit (a quoted or computed key, a value other than literal false, or other options beside it); only an options object holding that one key, set to literal false, is admitted",
			};
}

/**
 * Every `describe` option the caller sets, and every `shuffle` key this reader
 * cannot attribute. Pass the file's raw source; the two stripped views are
 * derived here so one call cannot mix them up.
 */
export function auditShuffleOptOuts(source: string): ShuffleOptOutAudit {
	const code = stripSource(source);
	const text = stripSource(source, { strings: "keep" });
	const admitted: string[] = [];
	const findings: ShuffleOptOutFinding[] = [];
	const report = (index: number, message: string) =>
		findings.push({ line: lineOf(text, index), message });
	/** Every describe options object read below, admitted or not. */
	const optionsSpans: Array<[number, number]> = [];
	const admittedSpans: Array<[number, number]> = [];

	for (const declaration of testDeclarations(source, code)) {
		if (declaration.callee !== "describe" && declaration.callee !== "suite")
			continue;
		const spans = argumentSpans(
			code,
			declaration.callParen,
			declaration.callEnd,
		);
		const candidate = spans[1];
		if (candidate === undefined) continue;
		const candidateText = code.slice(candidate[0], candidate[1]);
		if (!candidateText.startsWith("{")) {
			// A callback by name (`describe(t, body)`) is not an options object;
			// anything else here is options this file cannot attribute, because
			// they are built somewhere a per-file read cannot see.
			if (CALLBACK.test(candidateText)) continue;
			report(
				candidate[0],
				`describe "${declaration.title}": its options are not a literal object in this file, so a shuffle opt-out in them is unattributable (bound in another module, or a spread call)`,
			);
			optionsSpans.push(candidate);
			continue;
		}
		const close = matchingCloseIndex(code, candidate[0], "{", "}");
		if (close !== candidate[1] - 1) {
			report(
				candidate[0],
				`describe "${declaration.title}": its options object is not a single literal`,
			);
			optionsSpans.push(candidate);
			continue;
		}
		const span: [number, number] = [candidate[0], close + 1];
		optionsSpans.push(span);
		const inner = code.slice(candidate[0] + 1, close);
		const keyAt = shuffleKeyBetween(text, candidate[0], close);
		const verdict = optionsVerdict(inner, keyAt !== undefined);
		if (!verdict.admitted) {
			report(
				candidate[0],
				`describe "${declaration.title}": ${verdict.reason}`,
			);
			continue;
		}
		if (keyAt === undefined) continue;
		if (!declaration.live) {
			report(
				candidate[0],
				`describe "${declaration.title}": opts out of shuffle but vitest never runs it (a skip or todo modifier, or an enclosing skipped suite), so its registry row would vouch for a suite the run does not include`,
			);
			admittedSpans.push(span);
			continue;
		}
		admitted.push(declaration.title);
		admittedSpans.push(span);
	}

	// The net behind the structural read: a `shuffle` key written anywhere else
	// in the file — a shared options object, a helper, a fixture factory — is
	// not attributable, so it reds instead of passing unclassified.
	for (const match of text.matchAll(KEY)) {
		const at = match.index ?? 0;
		if (admittedSpans.some(([a, b]) => at >= a && at < b)) continue;
		// A key inside an options object already reported above, by its own
		// reason; this loop answers only for keys nothing above looked at.
		if (optionsSpans.some(([a, b]) => at >= a && at < b)) continue;
		report(
			at,
			"a shuffle option key outside any describe options object: a shared options object, a helper, or a config is not attributable, so this census cannot tell which suite it opts out",
		);
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
 * reds (#4611 review r1 M2, M3).
 */
export function censusShuffleOptOuts(
	entries: Iterable<{ file: string; source: string }>,
): ShuffleOptOutCensus {
	const optedOut = new Set<string>();
	const findings: string[] = [];
	for (const { file, source } of entries) {
		const audit = auditShuffleOptOuts(source);
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
