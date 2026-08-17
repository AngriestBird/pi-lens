/**
 * Single source of truth for "scratch/cache tree" exclusion, shared by every
 * runner that hands a DIRECTORY to an external binary and lets that binary do
 * its own tree walk.
 *
 * pi-lens's own in-process walkers (`source-filter.ts`/`source-walker.ts`,
 * `getProjectIgnoreMatcher`) already route every entry through
 * `isExcludedDirName`/`EXCLUDED_DIRS` (`file-utils.ts`) — that's how knip,
 * jscpd, and the tree-sitter project scan skip `.pi/`, `node_modules/`, etc.
 * But a runner that shells out with `cwd`/`--source <dir>` and lets the
 * EXTERNAL tool walk (gitleaks `detect --source`, `trivy fs`, `opengrep scan
 * <dir>`) bypasses that walker entirely — the tool sees the raw tree,
 * including pi-ecosystem scratch/data directories that were never meant to be
 * scan targets (#1562: `.pi/greedysearch-sources/` — a gitignored web-research
 * cache — served a `YOUR_API_KEY` doc-example placeholder to the agent as a
 * "leaked secret").
 *
 * This module derives each such runner's native exclude syntax from the SAME
 * `EXCLUDED_DIRS` list `file-utils.ts` already uses for the in-process walk,
 * rather than hand-maintaining a parallel per-tool list (the single-source-of-
 * truth rule that #883 encodes — a hand-copied list is a defect in itself:
 * `dead-code-client.ts`'s `VULTURE_EXCLUDES` had drifted from `EXCLUDED_DIRS`
 * before this fix, e.g. missing `.pi`/`.claude`/`.next`).
 *
 * Deliberately NOT `.gitignore`-based: a secrets scanner (gitleaks, trivy's
 * `secret` scanner) must still see an untracked `.env` with a real credential
 * — `.env` is commonly gitignored, so blanket "respect .gitignore" would hide
 * exactly the file classes these scanners exist to catch (#1562 design note).
 * `EXCLUDED_DIRS` is a narrower, deliberate list of scratch/cache/vendor
 * directory NAMES (`.pi`, `.claude`, `node_modules`, `dist`, …), not a
 * gitignore pattern set.
 */

import { EXCLUDED_DIRS, getExcludedDirGlobs, isExcludedDirName } from "./file-utils.js";

/** Directory-name entries only — drops glob entries (e.g. `*.dSYM`) that a
 * bare directory-name/regex exclude can't express. */
function literalExcludedDirNames(): string[] {
	return EXCLUDED_DIRS.filter((name) => !name.includes("*") && !name.includes("?"));
}

/**
 * `**\/name/**` glob patterns for tools that take doublestar globs
 * (trivy `--skip-dirs`, opengrep/semgrep `--exclude`). Reuses
 * `file-utils.ts`'s own glob derivation so both walkers and shell-out runners
 * stay byte-for-byte in sync.
 */
export function getScratchTreeGlobPatterns(): string[] {
	return getExcludedDirGlobs();
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex patterns for gitleaks's `[allowlist] paths` config array — matched
 * against the finding's (forward-slash) relative path. Anchored so `.pi`
 * matches the directory `.pi/` anywhere in the tree but not a file merely
 * containing the substring (e.g. `api.pipeline.ts`).
 */
export function getScratchTreeGitleaksAllowlistPaths(): string[] {
	return literalExcludedDirNames().map(
		(name) => `(?:^|/)${escapeRegExp(name)}(?:/.*)?$`,
	);
}

/** Bare directory names, for tools (opengrep/semgrep `--exclude`) that treat a
 * slash-free pattern as "this directory name, anywhere in the tree". */
export function getScratchTreeDirNames(): string[] {
	return literalExcludedDirNames();
}

/**
 * Fnmatch-style glob patterns (`star/name/star`, not doublestar) for
 * vulture's `--exclude` — the format `dead-code-client.ts` needs.
 */
export function getScratchTreeFnmatchPatterns(): string[] {
	return literalExcludedDirNames().map((name) => `*/${name}/*`);
}

/**
 * True when any path segment of `relPath` (forward- or back-slash separated)
 * is a scratch/cache tree name from the shared `EXCLUDED_DIRS` policy. Used
 * for the TS-side post-filter/observability classification that backstops
 * the native excludes above — belt-and-suspenders because we can't exercise
 * the real gitleaks/trivy/opengrep binaries' own glob/regex engines in unit
 * tests, only assert the args/config we hand them.
 */
export function isUnderScratchTree(relPath: string): boolean {
	const segments = relPath.split(/[/\\]/).filter(Boolean);
	// Drop the final segment when it looks like the file itself (no trailing
	// slash convention here) — irrelevant either way since isExcludedDirName
	// only matches directory-shaped names in EXCLUDED_DIRS, never a bare
	// filename, so checking every segment (including a same-named file) is
	// safe and simpler than trying to detect "is this the leaf file".
	return segments.some((segment) => isExcludedDirName(segment));
}
