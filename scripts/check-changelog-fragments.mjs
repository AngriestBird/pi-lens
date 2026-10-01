#!/usr/bin/env node
// Fast-fail changelog-fragment validator (refs #1844, #3795).
//
// Reuses parseEntry/validateChangelogEntries from rollup-changelog.mjs --
// the SAME parser tests/scripts/changelog-entries.test.ts exercises and that
// the release rollup relies on. This script adds no parsing rules of its
// own; it exists only to run that check standing alone, with no `npm
// install` and no `npm run build`, so a bad fragment fails in seconds
// instead of after the full Unit-tests lap (#1844 comment: four PRs in one
// day paid a full CI lap each for this).
//
// #3795: it also fails when the PR diff adds more than one `.changelog/`
// fragment, naming them. Two fold rounds added a second fragment to a PR
// that already had one (#3774, #3768), against the one-fragment-per-change
// rule the PR template states. `--base <ref>` supplies the PR base; when it
// is absent the count rule is skipped and only the shape check runs.
//
// Usage: node scripts/check-changelog-fragments.mjs [--base <ref>]

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { validateChangelogEntries } from "./rollup-changelog.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `git` seam shape used below: `(args, options) => string`. The default binds
// the repo's shared git-fixture-env wrapper (GIT_* scrubbed, GIT_CONFIG_GLOBAL
// pinned) so scripts/**/*.mjs has no bare Git spawn (governance row in
// tests/config/git-fixture-governance.test.ts); tests inject a fixture-scoped
// runner with the same shape.
const runGit = (args, options) => gitExecFileSync(args, options);

/**
 * The `.changelog/*.md` files the range adds between `base` and the working
 * tree, or `null` when no base was supplied or Git could not answer (a shallow
 * checkout, a missing ref). The working tree is the comparison point, not
 * HEAD, so a fragment a worker has written but not committed is still counted
 * before push; untracked files are unioned in for the same reason.
 * `README.md` is documentation, not a fragment.
 */
export function addedChangelogFragments({
	base,
	cwd = SCRIPT_ROOT,
	git = runGit,
} = {}) {
	if (!base) return null;
	try {
		const mergeBase = String(
			git(["merge-base", "HEAD", base], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).trim();
		if (!mergeBase) throw new Error("merge-base returned no commit");
		const diff = git(
			[
				"diff",
				"--diff-filter=A",
				"--name-only",
				mergeBase,
				"--",
				".changelog/",
			],
			{ cwd, encoding: "utf8" },
		);
		const untracked = git(
			["ls-files", "--others", "--exclude-standard", "--", ".changelog/"],
			{ cwd, encoding: "utf8" },
		);
		return [...new Set(`${diff}\n${untracked}`.split(/\r?\n/))]
			.filter(
				(file) =>
					/^\.changelog\/[^/]+\.md$/.test(file) &&
					file !== ".changelog/README.md",
			)
			.sort();
	} catch {
		return null;
	}
}

/**
 * The PR-level changelog gate. Fails when the diff adds more than one
 * fragment; otherwise runs the shared shape validation. `fragments` is the
 * added set when Git answered, else `null`.
 */
export function checkChangelogFragments({
	base,
	cwd = SCRIPT_ROOT,
	git = runGit,
	rootDir = SCRIPT_ROOT,
} = {}) {
	const fragments = addedChangelogFragments({ base, cwd, git });
	if (base && fragments === null) {
		return {
			valid: false,
			fragments: null,
			message: `unable to resolve changelog comparison base: ${base}`,
		};
	}
	if (fragments && fragments.length > 1) {
		return {
			valid: false,
			fragments,
			message: `PR diff adds ${fragments.length} changelog fragments; keep exactly one per PR: ${fragments.join(", ")}`,
		};
	}
	const entries = validateChangelogEntries({ rootDir });
	return {
		valid: true,
		fragments,
		message: `changelog fragments OK (${entries.length} entr${entries.length === 1 ? "y" : "ies"} in .changelog/)`,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const baseIndex = process.argv.indexOf("--base");
	const cwdIndex = process.argv.indexOf("--cwd");
	const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
	const cwd = cwdIndex === -1 ? SCRIPT_ROOT : process.argv[cwdIndex + 1];
	const invalidArgument =
		(baseIndex !== -1 && (!base || base.startsWith("--"))) ||
		(cwdIndex !== -1 && (!cwd || cwd.startsWith("--")));
	const result = invalidArgument
		? {
				valid: false,
				message:
					"usage: node scripts/check-changelog-fragments.mjs [--base <ref>] [--cwd <dir>]",
			}
		: checkChangelogFragments({ base, cwd, rootDir: cwd });
	if (result.valid) {
		console.log(result.message);
	} else {
		console.error(result.message);
		process.exitCode = 1;
	}
}
