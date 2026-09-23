/**
 * #3278 acceptance criterion 3 — the ABSENCE detector for the runner
 * reported-path-identity family.
 *
 * `tests/config/path-key-fold-sweep.test.ts` enumerates existing case FOLDS, so
 * a site with NO fold at all presents nothing to count: measured while fixing
 * #3277, mutating `go-vet.ts` to a hand-rolled `toLowerCase` compare left that
 * sweep GREEN. Eleven members of this family were invisible to it for exactly
 * that reason. This sweep counts the opposite thing — every runner or tool-client
 * site that still answers "is this reported diagnostic about the dispatched
 * file?" with its OWN predicate instead of the seam — and pins the census
 * shrink-only.
 *
 * The recurrence it prevents is #209 / #3277 / #3278: a runner compares the
 * tool's spelling of the edited file against the dispatcher's with `===`,
 * `!==`, `endsWith` or a basename, so a spelling that differs only in case
 * (the SAME file on Windows and on a case-folding POSIX mount) drops every
 * finding for that file and the run is reported clean — or, in the `endsWith`
 * and basename directions, a DIFFERENT file's finding is attributed to it. The
 * sanctioned spelling is
 * `pathsEqual(path.resolve(<the cwd the tool ran in>, reported), absTarget)`.
 *
 * It also closes `path-key-fold-sweep`'s `PATH_CALL` blind spot for this
 * family (#3278 criterion 4): that needle requires a `path.`/`win32.`/`posix.`
 * qualifier, and several runners import `resolve`/`join` BARE from
 * `node:path` — measured on `go-vet.ts`, where the qualified needle matched 0
 * and the bare call was the live one. `PATH_CALL_HERE` below matches both.
 *
 * Detector hygiene (AGENTS.md defect shape 38): the scan runs over
 * comment-and-string-blanked source, so a comment or string copy of the needle
 * can neither create a finding nor launder one away. A comparison against a
 * blanked string LITERAL is skipped by a per-needle policy documented at
 * `LITERAL_OPERAND` — lowercasing or comparing a basename against `".bin"` or
 * `"dockerfile"` is file-KIND detection, a different transformation with a
 * different correctness argument.
 */

import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	codeMatches,
	listSourceFiles,
	matchingOpenIndex,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const RUNNERS_ROOT = path.resolve(REPO_ROOT, "clients/dispatch/runners");

/**
 * #3286 widened the population: the family is NOT confined to
 * `clients/dispatch/runners/**`. A tool's autofix half lives in its
 * `clients/<tool>-client.ts`, and `ruff-client.ts` held the same bare `!==` over
 * two `path.resolve` results that nine runners held — invisible to this sweep
 * and to #3284's grep, both of which stopped at the runners directory, so it
 * shipped as the #3278 remainder instead of being caught.
 *
 * The rule is the GLOB, not a list of names: every `clients/*-client.ts` is in,
 * so a new tool client joins the population by existing. MEASURED cost of the
 * widening over the 18 tool clients, rather than the ~15 exemption rows #3286
 * predicted for all of `clients/`: the census flags TWO sites — the
 * `ruff-client.ts` member this round folds, and one non-member registered in
 * `NON_MEMBER_PINS` below. The detector's own policies (`LITERAL_OPERAND`, the
 * `relative`/`dirname` exclusions) already drop the containment, walk-up and
 * file-KIND shapes that made the prediction pessimistic.
 *
 * Nested directories (`clients/lsp/`, `clients/mcp/`, …) hold no `*-client.ts`
 * today and are excluded rather than silently in: a client under one of them
 * would be a new population question, not an automatic member.
 */
const CLIENTS_ROOT = path.resolve(REPO_ROOT, "clients");
const TOOL_CLIENT_SUFFIX = "-client.ts";

/**
 * A string or template-literal operand. Comparing a path against a LITERAL is
 * never reported-path identity: it is kind detection (`=== ".bin"`) or
 * containment (`!== ".."`, `startsWith("../")`). String contents are blanked by
 * `stripForScan`, so the opening quote or backtick is what survives — a
 * template with a live `${…}` interpolation still starts with a backtick.
 */
const LITERAL_OPERAND = /^\s*(?:"|'|`)/;

/**
 * A call that produces a whole-path IDENTITY, with the `path.`/`win32.`/`posix.`
 * qualifier OPTIONAL so a bare `resolve(`/`join(` imported from `node:path`
 * counts — the blind spot `path-key-fold-sweep`'s `PATH_CALL` has, measured on
 * `go-vet.ts` (#3278 criterion 4).
 *
 * `relative` and `dirname` are deliberately NOT here. A `path.relative` result
 * is a FRAGMENT used for containment (`helm-lint.ts`'s `isWithin`,
 * `go-vet.ts`'s `fileRel.startsWith("../")`) and a `path.dirname` result is a
 * walk cursor (`shellcheck.ts`/`vale.ts`'s `parent === current` termination) —
 * different questions with different correctness arguments, and no member of
 * this family was ever written with either. `basename` IS here: it is
 * `cue-vet.ts`'s own over-merge shape.
 */
const PATH_CALL_HERE =
	/\b(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*\(/;

const PATH_CALLEE =
	/(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*$/;

/**
 * A local whose initializer IS such a call: `const resolvedTarget =
 * path.resolve(filePath);`. Six of #3278's members wrote the comparison in TWO
 * statements, so both operands are plain identifiers and an adjacency-only
 * needle sees nothing — measured: the first draft of this sweep flagged 5 of the
 * 9 live members and silently missed `javac`, `zig-check`, `cpp-check` and
 * `dotnet-build`. One hop of local dataflow is what closes that.
 */
const PATH_DERIVED_DECL =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*\(/g;

/** The two operators this family compares with. */
const IDENTITY_COMPARISON = /===|!==/g;
const SUFFIX_COMPARISON = /\.\s*(?:endsWith|startsWith)\s*\(/g;

/**
 * The second family spelling: hand-fold the separators, THEN compare — the shape
 * `dart-analyze.ts` carried until #3278 and `gleam-check.ts` until #3285.
 * Matched on RAW source through `codeMatches` because the needle IS a regex
 * literal, whose body string-blanking erases (the same mechanism
 * `path-key-fold-sweep`'s shape A uses), while `codeMatches` still drops any
 * match whose span is a comment or a string.
 */
const SLASH_FOLD_COMPARE =
	/\.replace\(\s*\/\\\\\/g\s*,\s*["'`]\/["'`]\s*\)\s*(?:\.\s*(?:endsWith|startsWith)\s*\(|===|!==)/g;

function stripForScan(source: string): string {
	return stripSource(source, { strings: "blank" });
}

/** The no-predicate direction of this census (#3295). */
const LOCATION_CALL = /\b(?:match|exec)\s*\(/g;
const LOCATION_SHAPE = /:\(\\d\+\):\(\\d\+\)/;
const JSON_PARSE_CALL = /\bJSON\.parse\s*\(/;
/**
 * JSON path fields currently covered by this lexical census. The two live
 * blanket-stamp shapes are `item.file` (shellcheck) and `resultEntry.Target`
 * (trivy-config); generic `filename`, `path`, and nested `location.file`
 * parsers are intentionally outside this detector until their output contract
 * is separately classified. The runner sweep still covers those shapes when
 * they use a local identity comparison.
 */
const JSON_PATH_FIELD = /\b(?:item\.file|resultEntry\.Target)\b/;
const DISPATCH_PATH_STAMP = /\bfilePath\s*,/;

export function countLocationParsersWithoutPathsEqual(source: string): number {
	const stripped = stripForScan(source);
	const hasLocationCapture = codeMatches(source, LOCATION_CALL).some((match) =>
		LOCATION_SHAPE.test(
			source.slice(match.index ?? 0, (match.index ?? 0) + 400),
		),
	);
	const hasJsonPath =
		JSON_PARSE_CALL.test(stripped) &&
		JSON_PATH_FIELD.test(stripped) &&
		DISPATCH_PATH_STAMP.test(stripped) &&
		/\bdiagnostic\w*\b/i.test(stripped);
	return (hasLocationCapture || hasJsonPath) &&
		!/\bpathsEqual\s*\(/.test(stripped)
		? 1
		: 0;
}

/** Names bound, one hop, to a whole-path call in this file. */
function pathDerivedNames(stripped: string): Set<string> {
	const names = new Set<string>();
	for (const match of stripped.matchAll(PATH_DERIVED_DECL)) names.add(match[1]);
	return names;
}

interface Operand {
	/** The expression IS a path call written right at the operator. */
	inlineCall: boolean;
	/** The expression is a name bound one hop to a path call. */
	derivedName: boolean;
}

/** The expression ENDING at `index` (exclusive). */
function leftOperand(
	stripped: string,
	index: number,
	names: Set<string>,
): Operand {
	const before = stripped.slice(0, index);
	const trimmed = before.trimEnd();
	if (trimmed.endsWith(")")) {
		const open = matchingOpenIndex(stripped, trimmed.length - 1, "(", ")");
		return {
			inlineCall:
				open > 0 &&
				PATH_CALLEE.test(stripped.slice(Math.max(0, open - 40), open)),
			derivedName: false,
		};
	}
	const name = /([A-Za-z_$][\w$]*)$/.exec(trimmed);
	return { inlineCall: false, derivedName: name != null && names.has(name[1]) };
}

/** The expression STARTING at `index`. */
function rightOperand(
	stripped: string,
	index: number,
	names: Set<string>,
): Operand {
	const after = stripped.slice(index, index + 200).trimStart();
	const inlineCall = new RegExp(`^${PATH_CALL_HERE.source}`).test(after);
	const name = /^([A-Za-z_$][\w$]*)/.exec(after);
	return {
		inlineCall,
		derivedName: !inlineCall && name != null && names.has(name[1]),
	};
}

/**
 * Two path expressions compared for identity: either side written as the path
 * call itself, or BOTH sides names bound to one. "One side derived, the other
 * anything" is deliberately NOT enough — that rule flagged the `parent ===
 * current` walk termination in `shellcheck.ts` and `vale.ts`, which is not this
 * family (measured; see PATH_CALL_HERE's doc).
 */
function isFamilyCompare(left: Operand, right: Operand): boolean {
	return (
		left.inlineCall ||
		right.inlineCall ||
		(left.derivedName && right.derivedName)
	);
}

/**
 * Every site in one runner file that decides path identity with its own
 * predicate, keyed on the COMPARISON's position so a site both arms see counts
 * once.
 */
export function countLocalPathIdentityCompares(source: string): number {
	const stripped = stripForScan(source);
	const names = pathDerivedNames(stripped);
	const flagged = new Set<number>();

	for (const match of stripped.matchAll(IDENTITY_COMPARISON)) {
		const at = match.index ?? 0;
		const rightStart = at + match[0].length;
		if (LITERAL_OPERAND.test(stripped.slice(rightStart, rightStart + 8)))
			continue;
		if (
			isFamilyCompare(
				leftOperand(stripped, at, names),
				rightOperand(stripped, rightStart, names),
			)
		) {
			flagged.add(at);
		}
	}

	for (const match of stripped.matchAll(SUFFIX_COMPARISON)) {
		const at = match.index ?? 0;
		const argStart = at + match[0].length;
		if (LITERAL_OPERAND.test(stripped.slice(argStart, argStart + 8))) continue;
		if (
			isFamilyCompare(
				leftOperand(stripped, at, names),
				rightOperand(stripped, argStart, names),
			)
		) {
			flagged.add(at);
		}
	}

	for (const match of codeMatches(source, SLASH_FOLD_COMPARE)) {
		flagged.add(match.index ?? 0);
	}
	return flagged.size;
}

function census(): { counts: Record<string, number>; scanned: number } {
	const files = [
		...listSourceFiles(RUNNERS_ROOT, { extensions: [".ts"] }),
		...listSourceFiles(CLIENTS_ROOT, {
			extensions: [TOOL_CLIENT_SUFFIX],
			exclude: (relative) => relative.includes("/"),
		}),
	];
	const counts: Record<string, number> = {};
	let scanned = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		scanned += 1;
		const count = countLocalPathIdentityCompares(source);
		if (count > 0) counts[relativePosix(REPO_ROOT, file)] = count;
	}
	return { counts, scanned };
}

const REMEDIATION =
	"A runner or tool client decides reported-path identity with its own " +
	"predicate. Route it " +
	"through `pathsEqual(path.resolve(<the cwd the tool ran in>, reported), " +
	"absTarget)` (clients/path-utils.ts) and shrink this pin. Refs #3278.";

/**
 * The remaining local predicates, file → count. Shrink-only: `auditSymbolCounts`
 * fails on movement in EITHER direction, so restoring a member's deleted
 * compare, adding one in a new runner or tool client, and removing one without
 * shrinking the pin all red.
 *
 * EMPTY since #3285/#3286: the family has no member left that decides
 * reported-path identity for itself.
 *
 * `gleam-check.ts` held the last runner row (`@1`,
 * `!sourcePath.replace(…).endsWith(filePath.replace(…))`) because its
 * `endsWith` was LOAD-BEARING for codespan's `┌─` locus gutter and #3284 had no
 * captured gleam output to establish that gutter from. #3285 established it from
 * gleam v1.18.1 + codespan-reporting 0.13.1, moved the gutter out of the
 * location CAPTURE, and folded the compare; `clients/ruff-client.ts` was added
 * to the population by the widening above and folded in the same round (#3286).
 */
const LOCAL_COMPARE_PINS: Readonly<Record<string, number>> = {};

/** Exact shrink-only pin for parsers that capture locations without a predicate. */
const NO_PREDICATE_PINS: Readonly<Record<string, number>> = {};

/**
 * Sites the detector flags that are NOT members of this family: BOTH operands
 * are directories this process derived from its own `path.resolve`, with no
 * tool output on either side. Registered, never silenced — the count is pinned
 * the same shrink-only way, so a real member landing in one of these files
 * presents a different id and reds.
 *
 * - `clients/test-runner-client.ts@1` — `path.resolve(root) !== dispatch`
 *   (`clients/test-runner-client.ts:832`) asks "is the anchored LANGUAGE root a
 *   different directory from the dispatch root?" so the runner-detection ladder
 *   does not probe the same directory twice (#2879 round 2, F1). Neither side is
 *   a reported path, and a case-variant answer costs one idempotent re-probe,
 *   not a dropped finding — the whole cost of #3286's population widening.
 */
const NON_MEMBER_PINS: Readonly<Record<string, number>> = {
	"clients/test-runner-client.ts": 1,
};

function stalePins(
	counts: Record<string, number>,
	pins: Readonly<Record<string, number>>,
): string[] {
	return Object.entries(pins)
		.filter(([file, pinned]) => (counts[file] ?? 0) !== pinned)
		.map(([file, pinned]) => `${file}@${pinned} -> ${counts[file] ?? 0}`);
}

describe("runner reported-path attribution single-source-of-truth (#3278)", () => {
	it("has no unpinned local reported-path compare in any runner or tool client", () => {
		const { counts, scanned } = census();
		assertNonEmptyScan(
			"clients/dispatch/runners + clients/*-client.ts source files",
			scanned,
			78,
		);
		const pinned = { ...LOCAL_COMPARE_PINS, ...NON_MEMBER_PINS };
		const audit = auditSymbolCounts({
			sweepName: "local reported-path compare (#3278)",
			counts,
			pinned,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(counts, pinned),
			"a pinned local compare is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("has no unpinned location parser without pathsEqual (#3295)", () => {
		const counts: Record<string, number> = {};
		const files = [
			...listSourceFiles(RUNNERS_ROOT, { extensions: [".ts"] }),
			...listSourceFiles(CLIENTS_ROOT, {
				extensions: [TOOL_CLIENT_SUFFIX],
				exclude: (relative) => relative.includes("/"),
			}),
		];
		for (const { file, source } of readWalkedFiles(files)) {
			const count = countLocationParsersWithoutPathsEqual(source);
			if (count > 0) counts[relativePosix(REPO_ROOT, file)] = count;
		}
		const audit = auditSymbolCounts({
			sweepName: "location parser without reported-path predicate (#3295)",
			counts,
			pinned: NO_PREDICATE_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
	});

	// The detector's own teeth, in both directions, on synthetic source: without
	// these the sweep could silently stop matching and read as "family clean".
	it("detects every spelling the family has actually shipped", () => {
		expect(
			countLocalPathIdentityCompares(
				"const a = path.resolve(reported);\n" +
					"const b = path.resolve(filePath);\n" +
					"if (a !== b) continue;",
			),
			"the TWO-statement form — javac, zig-check, cpp-check, dotnet-build",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (path.resolve(reported) !== absTarget) continue;",
			),
			"inline qualified call on the left (detekt)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"const keep = resolve(cwd, m[1]) === absTarget;",
			),
			"bare `resolve` import — path-key-fold-sweep's PATH_CALL blind spot",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (absEdited === resolve(d.filePath)) keep();",
			),
			"the call on the RIGHT of the comparison (rust-clippy)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"return path.posix.basename(normalized) === fileName;",
			),
			"the basename over-merge (cue-vet)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (!sourcePath.endsWith(path.resolve(filePath))) continue;",
			),
			"the call as the endsWith ARGUMENT",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (!path.resolve(file).endsWith(target)) continue;",
			),
			"endsWith hung off the call (dart-analyze's deleted outer arm)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				'if (!a.replace(/\\\\/g, "/").endsWith(b.replace(/\\\\/g, "/"))) x();',
			),
			"hand-fold the separators, then compare (gleam-check's, until #3285)",
		).toBe(1);
	});

	it("does not fire on the sanctioned spelling, on neighbouring path idioms, or on prose", () => {
		expect(
			countLocalPathIdentityCompares(
				"if (!pathsEqual(path.resolve(cwd, reported), absTarget)) continue;",
			),
			"the seam this sweep exists to drive callers onto",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"let current = path.resolve(cwd);\n" +
					"const parent = path.dirname(current);\n" +
					"if (parent === current) break;",
			),
			"walk-up termination (shellcheck.ts, vale.ts) — not this family",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"const relative = path.relative(root, candidate);\n" +
					'return relative === "" || !relative.startsWith("..");',
			),
			"containment (helm-lint.ts's isWithin, helm-render.ts) — not this family",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				'if (path.basename(filePath).toLowerCase() === "dockerfile") return;',
			),
			"file-KIND detection against a literal (LITERAL_OPERAND policy)",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"// if (path.resolve(reported) !== absTarget) continue;",
			),
			"a comment copy of the needle must never create a finding",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				'const doc = "path.resolve(reported) !== absTarget";',
			),
			"a string copy of the needle must never create a finding",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const match = raw.match(/^(.*?):(\\d+):(\\d+)/);",
			),
			"bare location parser remains a census member",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"// pathsEqual\nconst match = raw.match(/^(.*?):(\\d+):(\\d+)/);",
			),
			"a comment must not self-excuse a parser",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				'const note = "pathsEqual";\nconst match = raw.match(/^(.*?):(\\d+):(\\d+)/);',
			),
			"a string literal must not self-excuse a parser",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const parsed = JSON.parse(raw) as Array<{ file?: string }>;\n" +
					"const diagnostics = parsed.map((item) => ({ filePath, message: item.file }));\n" +
					"return diagnostics;",
			),
			"JSON file fields are part of the governed population",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				readFileSync(
					path.resolve(
						REPO_ROOT,
						"tests/fixtures/reported-path-attribution/sanctioned.ts",
					),
					"utf8",
				),
			),
		).toBe(0);
	});
});
