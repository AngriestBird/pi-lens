/**
 * #3278 acceptance criterion 3 — the ABSENCE detector for the runner
 * reported-path-identity family.
 *
 * `tests/config/path-key-fold-sweep.test.ts` enumerates existing case FOLDS, so
 * a site with NO fold at all presents nothing to count: measured while fixing
 * #3277, mutating `go-vet.ts` to a hand-rolled `toLowerCase` compare left that
 * sweep GREEN. Eleven members of this family were invisible to it for exactly
 * that reason. This sweep counts the opposite thing — every runner site that
 * still answers "is this reported diagnostic about the dispatched file?" with
 * its OWN predicate instead of the seam — and pins the census shrink-only.
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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	codeMatches,
	listSourceFiles,
	matchingCloseIndex,
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
 * A call that produces a path IDENTITY. Unlike `path-key-fold-sweep`'s
 * `PATH_CALL`, the `path.`/`win32.`/`posix.` qualifier is OPTIONAL, so a bare
 * `resolve(`/`join(` imported from `node:path` counts. `basename` IS here (it
 * is `cue-vet`'s own over-merge shape) — that is the difference from the
 * key-fold sweep, where lowercasing a basename is kind detection.
 */
const PATH_CALL_HERE =
	/\b(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|relative|join)\s*\(/g;

/** `=== ""` / `!== ""` after string blanking: a kind check, not path identity. */
const LITERAL_OPERAND = /^\s*(?:!==?|===?)\s*(?:""|''|``)/;

/** A bare identity comparison immediately after the call's closing paren. */
const COMPARISON_AFTER = /^\s*(?:===|!==)/;
/** A suffix comparison hung off the call's result. */
const SUFFIX_AFTER = /^\s*\.\s*(?:endsWith|startsWith)\s*\(/;
/** The call sits on the RIGHT of an identity comparison. */
const COMPARISON_BEFORE = /(?:===|!==)\s*$/;
/** The call is the ARGUMENT of a suffix comparison. */
const SUFFIX_BEFORE = /\.\s*(?:endsWith|startsWith)\s*\(\s*$/;

/**
 * The second family spelling: hand-fold the separators, THEN compare — the shape
 * `gleam-check.ts` still carries and `dart-analyze.ts` carried until #3278.
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

/**
 * Every site in one runner file that decides path identity with its own
 * predicate. Keyed on the PATH CALL's position, so a site both arms see counts
 * once.
 */
export function countLocalPathIdentityCompares(source: string): number {
	const stripped = stripForScan(source);
	const flagged = new Set<number>();
	for (const match of stripped.matchAll(PATH_CALL_HERE)) {
		const openIndex = (match.index ?? 0) + match[0].length - 1;
		const closeIndex = matchingCloseIndex(stripped, openIndex, "(", ")");
		if (closeIndex < 0) continue;
		const after = stripped.slice(closeIndex + 1, closeIndex + 40);
		const before = stripped.slice(
			Math.max(0, (match.index ?? 0) - 40),
			match.index,
		);
		if (LITERAL_OPERAND.test(after)) continue;
		if (
			COMPARISON_AFTER.test(after) ||
			SUFFIX_AFTER.test(after) ||
			COMPARISON_BEFORE.test(before) ||
			SUFFIX_BEFORE.test(before)
		) {
			flagged.add(match.index ?? 0);
		}
	}
	for (const match of codeMatches(source, SLASH_FOLD_COMPARE)) {
		flagged.add(match.index ?? 0);
	}
	return flagged.size;
}

function census(): { counts: Record<string, number>; scanned: number } {
	const files = listSourceFiles(RUNNERS_ROOT, { extensions: [".ts"] });
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
	"A runner decides reported-path identity with its own predicate. Route it " +
	"through `pathsEqual(path.resolve(<the cwd the tool ran in>, reported), " +
	"absTarget)` (clients/path-utils.ts) and shrink this pin. Refs #3278.";

/**
 * The remaining local predicates, file → count. Shrink-only: `auditSymbolCounts`
 * fails on movement in EITHER direction, so restoring a member's deleted
 * compare, adding one in a new runner, and removing one without shrinking the
 * pin all red.
 *
 * - `gleam-check.ts` — `!sourcePath.replace(…).endsWith(filePath.replace(…))`.
 *   Found by #3278's own shape sweep, NOT on #3278's member list, and
 *   deliberately left: `gleam` renders through `codespan_reporting::term::emit`
 *   (`compiler-core/src/diagnostic.rs:119` at v1.6.3), whose location line
 *   carries a `┌─` gutter, so the `endsWith` is LOAD-BEARING and a naive fold
 *   drops every gleam diagnostic. The repo has no captured gleam output to
 *   establish the gutter from, so the fold needs its own round. Filed as the
 *   #3278 remainder.
 */
const LOCAL_COMPARE_PINS: Readonly<Record<string, number>> = {
	"clients/dispatch/runners/gleam-check.ts": 1,
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
	it("has no unpinned local reported-path compare in any runner", () => {
		const { counts, scanned } = census();
		assertNonEmptyScan("clients/dispatch/runners source files", scanned, 60);
		const audit = auditSymbolCounts({
			sweepName: "local reported-path compare (#3278)",
			counts,
			pinned: LOCAL_COMPARE_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(counts, LOCAL_COMPARE_PINS),
			"a pinned local compare is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	// The detector's own teeth, in both directions, on synthetic source: without
	// these the sweep could silently stop matching and read as "family clean".
	it("detects every spelling the family has actually shipped", () => {
		expect(
			countLocalPathIdentityCompares(
				"if (path.resolve(reported) !== absTarget) continue;",
			),
			"bare !== after a qualified call (javac/zig/detekt/cpp-check/dotnet)",
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
			"the call as the endsWith ARGUMENT (gleam-check)",
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
			"hand-fold the separators, then compare (gleam-check's live shape)",
		).toBe(1);
	});

	it("does not fire on the sanctioned spelling, on kind detection, or on prose", () => {
		expect(
			countLocalPathIdentityCompares(
				"if (!pathsEqual(path.resolve(cwd, reported), absTarget)) continue;",
			),
			"the seam this sweep exists to drive callers onto",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				'if (path.basename(filePath).toLowerCase() === "dockerfile") return;',
			),
			"file-KIND detection, not path identity (LITERAL_OPERAND policy)",
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
	});
});
