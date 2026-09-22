/**
 * #1193 P3 enforcement: no NEW hand-rolled path transformation outside
 * `clients/path-utils.ts`.
 *
 * `toPosix` exists because the idiom `p.replace(/\\/g, "/")` was hand-copied
 * across the tree, and its own doc comment states the reason a lint rule was
 * impossible before the fold: "today a bare inline `.replace(/\\/g, "/")` is
 * byte-identical to the sanctioned use so it can't be ruled (#1158); once
 * everything routes through `toPosix`, an un-migrated inline `.replace`
 * becomes detectable." This is that detector. Four merged September path-key
 * defects (#3159, #3169, #3178 — four rounds — and #3192) are the recurrence
 * it prevents: every one of them was two spellings of one path deriving two
 * keys, and every new hand-rolled fold is a fresh chance at the same bug.
 *
 * It pins TWO shapes, per file, as a shrink-only census (`auditSymbolCounts`,
 * the same machinery the session-state sweep uses — a file whose count moves
 * in EITHER direction presents an id the pin does not name and fails loud):
 *
 *   A. **Raw separator fold** — a literal `.replace(/\\/g, "/")`. The
 *      sanctioned spelling is `toPosix`.
 *   B. **Path-key case fold** — a `.toLowerCase()` applied to the result of a
 *      `path`/`win32`/`posix` call, or sitting in the same statement as a
 *      `"win32"` platform test. The sanctioned spellings are
 *      `normalizeEphemeralMapKey` (process-local, same-run keys) and
 *      `normalizeMapKey`/`normalizeFilePath` (filesystem-canonical keys).
 *
 * Scanned trees are `clients/`, `tools/`, `mcp/` and `index.ts` — the runtime
 * surface where a path becomes a map key. `scripts/` is deliberately out:
 * its `.mjs` helpers run before `npm run build` in workflows that never
 * install, so they cannot import the compiled seam (the same build-order
 * constraint `tests/config/escape-regexp-fold-sweep.test.ts` documents for
 * `merge-train-lane.mjs`), and none of them derives a map key.
 *
 * Source is read through `stripSource(..., { strings: "keep" })`: comments
 * are blanked, so a needle written only in prose can neither be flagged nor
 * satisfy the canonical-leaf check (the #1635/#1692 comment-laundering shape,
 * AGENTS.md defect shape 38); regex literals and string contents are
 * PRESERVED, because shape A's needle IS a regex literal and shape B's
 * platform test IS a string literal — the default "blank" policy erases both
 * and would turn this sweep into a permanent false clean.
 *
 * SWEEP_HEURISTIC_LIMITS. Shape B's second arm keys on a `"win32"` literal in
 * the same statement, so a fold behind an already-hoisted boolean
 * (`const isWin = process.platform === "win32"; … isWin ? x.toLowerCase() : x`)
 * is not detected. That is a known blind spot, not a silent one: shape B's
 * first arm still catches every fold applied DIRECTLY to a path expression,
 * which is how all five #1193 P3 members were written.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to own both transformations. */
const CANONICAL_FILE = "clients/path-utils.ts";

/** Shape A: the literal `.replace(/\\/g, "/")` idiom `toPosix` replaced. */
const SLASH_FOLD = /\.replace\(\s*\/\\\\\/g\s*,\s*["'`]\/["'`]\s*\)/g;

/**
 * A call that produces a path IDENTITY; shape B's first arm roots here.
 *
 * `basename`/`extname`/`dirname` are deliberately NOT here. Lowercasing a
 * BASENAME or an EXTENSION is file-KIND detection (`tool-policy.ts`'s
 * `path.extname(filePath).toLowerCase()`, `formatters.ts`'s dockerfile check,
 * `instance-reaper.ts`'s process-name match) — a different transformation with
 * a different correctness argument, and folding it into this census would bury
 * the path-key signal under ~10 unrelated sites.
 */
const PATH_CALL =
	/\b(?:(?:path|win32|posix)\s*\.\s*(?:resolve|normalize|join|relative)|toPosix)\s*\(/g;

/**
 * Each method call in the chain that follows `closeIndex`, up to 8 links, with
 * the index of its own name. Both shape-B arms key the flagged set on a
 * `.toLowerCase()`'s OWN position, so a site both arms see counts once.
 */
function chainedCallsAfter(
	source: string,
	closeIndex: number,
): Array<{ name: string; index: number }> {
	const links: Array<{ name: string; index: number }> = [];
	let cursor = closeIndex + 1;
	for (let link = 0; link < 8; link++) {
		const next = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(cursor));
		if (!next) break;
		links.push({ name: next[1], index: cursor + next[0].indexOf(next[1]) });
		const open = cursor + next[0].length - 1;
		const close = matchingCloseIndex(source, open, "(", ")");
		if (close === -1) break;
		cursor = close + 1;
	}
	return links;
}

/** The statement `index` sits in, bounded by the nearest `;`, `{` or `}`. */
function enclosingStatement(source: string, index: number): string {
	let start = index;
	while (start > 0 && !";{}".includes(source[start - 1])) start--;
	let end = index;
	while (end < source.length && !";{}".includes(source[end])) end++;
	return source.slice(start, end);
}

/**
 * The ONE stripping policy this sweep scans under — census and the
 * laundering self-tests below both go through it, so a single edit here can
 * never leave the self-tests guarding a policy the census no longer uses.
 */
export function stripForScan(raw: string): string {
	return stripSource(raw, { strings: "keep" });
}

/** Shape A occurrences in already-stripped source. */
export function countSlashFolds(stripped: string): number {
	return [...stripped.matchAll(SLASH_FOLD)].length;
}

/** Shape B occurrences in already-stripped source. */
export function countPathCaseFolds(stripped: string): number {
	const flagged = new Set<number>();
	// Arm 1: `.toLowerCase()` somewhere in the chain hanging off a path call.
	for (const match of stripped.matchAll(PATH_CALL)) {
		const open = match.index + match[0].length - 1;
		const close = matchingCloseIndex(stripped, open, "(", ")");
		if (close === -1) continue;
		for (const link of chainedCallsAfter(stripped, close)) {
			if (link.name === "toLowerCase") flagged.add(link.index);
		}
	}
	// Arm 2: `.toLowerCase()` in the same statement as a `"win32"` platform test.
	for (const match of stripped.matchAll(/\.\s*toLowerCase\s*\(\s*\)/g)) {
		const statement = enclosingStatement(stripped, match.index);
		if (!/["'`]win32["'`]/.test(statement)) continue;
		flagged.add(match.index + match[0].indexOf("toLowerCase"));
	}
	return flagged.size;
}

interface Census {
	slashFolds: Record<string, number>;
	caseFolds: Record<string, number>;
	scanned: number;
}

// Real per-tree floors, set well below each tree's population at authoring
// time (438/18/6/1) so ordinary growth never trips them, but a tree dropped
// from the walk reliably does — the #1718 empty-sweep shape.
const SCAN_ROOTS: ReadonlyArray<{ dir: string; floor: number }> = [
	{ dir: "clients", floor: 380 },
	{ dir: "tools", floor: 12 },
	{ dir: "mcp", floor: 3 },
];

function census(): Census {
	const files: string[] = [];
	for (const { dir, floor } of SCAN_ROOTS) {
		// `listSourceFiles` throws on a missing root; a renamed tree must fail
		// loud rather than quietly scan fewer files.
		const found = listSourceFiles(path.join(REPO_ROOT, dir), {
			extensions: [".ts"],
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/`, found.length, floor);
		files.push(...found);
	}
	files.push(path.join(REPO_ROOT, "index.ts"));

	const slashFolds: Record<string, number> = {};
	const caseFolds: Record<string, number> = {};
	for (const file of files) {
		const rel = relativePosix(REPO_ROOT, file);
		if (rel === CANONICAL_FILE) continue;
		const raw = readWalkedFile(file);
		if (raw === undefined) continue;
		const stripped = stripForScan(raw);
		const slash = countSlashFolds(stripped);
		const lower = countPathCaseFolds(stripped);
		if (slash > 0) slashFolds[rel] = slash;
		if (lower > 0) caseFolds[rel] = lower;
	}
	return { slashFolds, caseFolds, scanned: files.length };
}

/**
 * Pins the scan no longer confirms, `file@pinned` → `file@live`.
 *
 * `auditSymbolCounts` is deliberately asymmetric — a REGISTERED id the scan
 * stops flagging is fine there, because a registry routinely covers state a
 * heuristic cannot see. A shrink-only CENSUS is the opposite case: a row that
 * no longer describes a live fold is dead weight that makes the table read as
 * bigger than the debt it tracks, and the next migration slice would have no
 * signal that its deletion landed. Mutation M3c proved the gap — removing
 * `feature-hints.ts`'s fold left the sweep green under the audit alone.
 */
function stalePins(
	counts: Readonly<Record<string, number>>,
	pins: Readonly<Record<string, number>>,
): string[] {
	return Object.entries(pins)
		.filter(([file, pinned]) => (counts[file] ?? 0) !== pinned)
		.map(([file, pinned]) => `${file}@${pinned} -> ${counts[file] ?? 0}`);
}

const REMEDIATION =
	"A path transformation moved. Route a separator fold through `toPosix` and " +
	"a path-KEY case fold through `normalizeEphemeralMapKey` (process-local, " +
	"same-run) or `normalizeMapKey` (filesystem-canonical), both in " +
	`${CANONICAL_FILE} — then update this file's pin. Refs #1193.`;

/**
 * The raw-separator-fold census at #1193 P3, file → occurrence count. Every
 * row is an UNMIGRATED site, not an approved one: this table is the shrink
 * target the umbrella issue's P3/P4 slices work down. `auditSymbolCounts`
 * fails on movement in EITHER direction, so a new fold in a listed file, a
 * fold in an unlisted file, and a fold REMOVED without updating the pin all
 * red — the removal direction is what makes the table shrink deliberately
 * instead of drifting.
 */
const SLASH_FOLD_PINS: Readonly<Record<string, number>> = {
	"clients/actionable-warnings.ts": 1,
	"clients/cache-manager.ts": 1,
	"clients/codebase-model.ts": 1,
	"clients/config-locations.ts": 1,
	"clients/dispatch/dispatcher.ts": 1,
	"clients/dispatch/integration.ts": 2,
	"clients/dispatch/runner-context.ts": 3,
	"clients/dispatch/runners/actionlint.ts": 1,
	"clients/dispatch/runners/cue-vet.ts": 1,
	"clients/dispatch/runners/dart-analyze.ts": 1,
	"clients/dispatch/runners/gleam-check.ts": 2,
	"clients/feature-hints.ts": 1,
	"clients/file-role.ts": 2,
	"clients/file-utils.ts": 2,
	"clients/finding-identity.ts": 1,
	"clients/git-guard.ts": 1,
	"clients/lens-engine.ts": 2,
	"clients/lsp/client.ts": 1,
	"clients/lsp/edits.ts": 3,
	"clients/lsp/index.ts": 2,
	"clients/lsp/server.ts": 1,
	"clients/mcp/review.ts": 1,
	"clients/review-graph/workspace-modules.ts": 4,
	"clients/rules-scanner.ts": 1,
	"clients/test-runner-client.ts": 1,
	"clients/tool-cwd.ts": 1,
	"clients/zizmor-config.ts": 1,
	"index.ts": 1,
	"tools/lsp-navigation.ts": 1,
};

/**
 * The path-key case-fold census, file → occurrence count. Three of the four
 * rows carry a written reason, because each is a deliberate decision rather
 * than an unmigrated copy:
 *
 * - `dispatch/runners/elixir-check.ts` — elixirc reports `c:/…` where the
 *   runner holds `C:\…`, so the win32 arm compares two resolved paths
 *   case-insensitively. A genuine path-key fold, found BY this sweep and left
 *   for a later slice: it is a comparison, not a stored key, and folding it
 *   onto `normalizeEphemeralMapKey` would also fold separators, which is a
 *   behaviour change this slice does not carry tests for.
 * - `lsp/launch.ts` — the PATH-entry dedupe key, whose `platform` is an
 *   explicit ARGUMENT (`combinePathValuesForPlatform`); the seam reads
 *   `process.platform`, so it cannot express the simulated arm the ubuntu lane
 *   tests. See that function's own doc comment.
 * - `mcp/ipc.ts` — the cross-process IPC rendezvous hash. Deliberately NOT a
 *   map key: see the `workspaceHash` doc comment for why a pure derivation is
 *   required there and why neither seam fits.
 * - `runtime-tool-call.ts` — `toPosix(path.resolve(f)).toLowerCase()`, where
 *   the fold is the haystack for lowercase MARKER substrings, not a key.
 */
const CASE_FOLD_PINS: Readonly<Record<string, number>> = {
	"clients/dispatch/runners/elixir-check.ts": 2,
	"clients/lsp/launch.ts": 1,
	"clients/mcp/ipc.ts": 1,
	"clients/runtime-tool-call.ts": 1,
};

describe("path transformation single-source-of-truth (#1193)", () => {
	it("has no unpinned raw separator fold outside the canonical leaf", () => {
		const { slashFolds, scanned } = census();
		assertNonEmptyScan("clients/tools/mcp/index.ts source files", scanned, 400);
		const audit = auditSymbolCounts({
			sweepName: "raw separator fold (#1193 shape A)",
			counts: slashFolds,
			pinned: SLASH_FOLD_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(slashFolds, SLASH_FOLD_PINS),
			"a pinned separator fold is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("has no unpinned path-key case fold outside the canonical leaf", () => {
		const { caseFolds } = census();
		const audit = auditSymbolCounts({
			sweepName: "path-key case fold (#1193 shape B)",
			counts: caseFolds,
			pinned: CASE_FOLD_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(caseFolds, CASE_FOLD_PINS),
			"a pinned path-key case fold is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("the canonical leaf still owns both transformations", () => {
		const stripped = stripForScan(
			readFileSync(path.join(REPO_ROOT, CANONICAL_FILE), "utf8"),
		);
		expect(countSlashFolds(stripped)).toBeGreaterThan(0);
		expect(/export function toPosix\s*\(/.test(stripped)).toBe(true);
		expect(/export function normalizeEphemeralMapKey\s*\(/.test(stripped)).toBe(
			true,
		);
	});
});

/**
 * The detector's own threat model, as literal snippets — the #1692 attack
 * catalogue applied to this sweep. Each case runs the SAME `stripSource`
 * policy the census uses, so weakening that policy (dropping the comment
 * blanking, or switching `strings` to "blank") reds here and not only in a
 * whole-tree count nobody can read.
 */
describe("path-fold detectors resist comment and string laundering", () => {
	const strip = stripForScan;

	it("flags a real separator fold", () => {
		expect(countSlashFolds(strip('const a = p.replace(/\\\\/g, "/");'))).toBe(
			1,
		);
	});

	it("does not flag a separator fold written only in a line comment", () => {
		expect(
			countSlashFolds(strip('// legacy: p.replace(/\\\\/g, "/") is banned\n')),
		).toBe(0);
	});

	it("does not flag a separator fold written only in a block comment", () => {
		expect(
			countSlashFolds(strip('/** never write p.replace(/\\\\/g, "/") */\n')),
		).toBe(0);
	});

	it("flags a case fold applied to a resolved path", () => {
		expect(
			countPathCaseFolds(strip("const k = path.resolve(p).toLowerCase();")),
		).toBe(1);
	});

	it("flags a case fold behind a win32 platform test", () => {
		expect(
			countPathCaseFolds(
				strip('const k = process.platform === "win32" ? n.toLowerCase() : n;'),
			),
		).toBe(1);
	});

	it("does not flag a case fold described only in a comment", () => {
		expect(
			countPathCaseFolds(
				strip(
					'// we used to do path.resolve(p).toLowerCase() on "win32"\nconst k = p;',
				),
			),
		).toBe(0);
	});

	it("does not flag a basename or extension case fold", () => {
		// File-KIND detection, not key derivation — the narrowing PATH_CALL
		// documents. A pin row here would bury the path-key signal.
		expect(
			countPathCaseFolds(strip("const ext = path.extname(f).toLowerCase();")),
		).toBe(0);
		expect(
			countPathCaseFolds(strip("const b = path.basename(f).toLowerCase();")),
		).toBe(0);
	});

	it("counts one case fold per site, not once per detecting arm", () => {
		// `path.resolve(...).toLowerCase()` inside a `"win32"` ternary matches
		// BOTH arms; the flagged set is keyed by position so the pin stays a
		// count of SITES.
		expect(
			countPathCaseFolds(
				strip(
					'const k = process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);',
				),
			),
		).toBe(1);
	});
});
