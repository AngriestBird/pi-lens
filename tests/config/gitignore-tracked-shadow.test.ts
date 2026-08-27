import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Minimatch } from "../../clients/deps/minimatch.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * A git-tracked file that also matches a `.gitignore` pattern is invisible
 * to any ignore-respecting tool that doesn't special-case tracked status —
 * `rg`, plain `grep --exclude-from`, GitHub code search. Git itself keeps
 * tracking the file (`git status`/`git check-ignore` both special-case
 * already-indexed paths, so neither flags the shadow), but tools that walk
 * the filesystem and apply `.gitignore` textually do not (#2250).
 *
 * A `.gitignore` line with no `/` (other than a trailing one) matches the
 * BASENAME of a path at any depth — that's the documented gitignore rule
 * responsible for the shadow, and the one `rg`/`git check-ignore --no-index`
 * apply. Reproduce it directly with the same semantics, rather than relying
 * on an external `rg` binary that may not be on PATH in CI.
 *
 * Scoped to the `test-*` scratch-file family named in #2250 ("Test
 * directories and files" section of `.gitignore`), not the whole file: the
 * blanket `*.md`/`*.js`/`*.d.ts` rules elsewhere have their own dedicated
 * negation allowlists (docs, README, etc.) that a naive basename matcher
 * can't evaluate correctly without fully reimplementing gitignore
 * precedence. Those are a separate, larger audit outside this issue's scope.
 */
function unanchoredTestScratchPatterns(): string[] {
	const text = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("test-"))
		.filter((line) => !line.slice(0, -1).includes("/")); // no "/" except maybe trailing
}

function findShadowedTrackedFiles(): string[] {
	const tracked = gitExecFileSync("git", ["ls-files"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);

	const matchers = unanchoredTestScratchPatterns().map(
		(pattern) => new Minimatch(pattern, { matchBase: true, dot: true }),
	);

	return tracked.filter((file) => {
		const base = path.basename(file);
		return matchers.some((m) => m.match(base));
	});
}

describe("gitignore does not shadow tracked files (#2250)", () => {
	it("no git-tracked file's basename matches an unanchored .gitignore pattern", () => {
		const shadowed = findShadowedTrackedFiles();
		expect(shadowed).toEqual([]);
	});
});
