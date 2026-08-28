/**
 * Vitest globalSetup: fail loudly if a stray compiled `.js` sibling shadows a
 * `tests/**` `.ts` source (#2232).
 *
 * `tsconfig.build.json` excludes `tests/`, and `.gitignore`'s blanket `*.js`
 * rule hides anything compiled there from `git status` — so a `.js` file left
 * beside a test-support `.ts` (an earlier local `tsc` run, an editor
 * auto-compile, a stale config) never gets rebuilt away and never shows up as
 * dirty. Test import specifiers end in `.js`, so Node resolves that literal
 * file over the `.ts` source: the test silently runs old code with no signal
 * anything is wrong. This is how a PR #2226 verify-round probe of a FIXED file
 * reproduced pre-fix behavior — the only tell was that it contradicted the
 * diff the reviewer had just read.
 *
 * Unlike check-build-freshness.ts (which compares mtimes for dirs the build
 * DOES compile in place), there is no freshness comparison to make here:
 * nothing legitimately emits `.js` into `tests/`, so a same-named sibling's
 * mere existence is always residue.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testsRoot = join(repoRoot, "tests");

// Mirrors vitest.config.ts's sharedExclude: these carry their OWN toolchain's
// real compiled output (fixture inputs for external tools; the native-TS7
// live suite's copied-out temp project), not residue from THIS repo's build.
const SKIP_DIR_NAMES = new Set(["node_modules", "fixtures"]);
const SKIP_DIR_PREFIXES = ["native-ts7-live-"];

function shouldSkipDir(name: string): boolean {
	if (SKIP_DIR_NAMES.has(name)) return true;
	return SKIP_DIR_PREFIXES.some((p) => name.startsWith(p));
}

function* walkTestSources(dir: string): Generator<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (shouldSkipDir(entry.name)) continue;
			yield* walkTestSources(full);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			yield full;
		}
	}
}

/**
 * Pure(ish) scan, exported for unit testing. Returns the `.ts` sources under
 * `root` that have a same-named compiled `.js` sibling on disk.
 */
export function findShadowedTestSources(opts: { root: string }): string[] {
	const shadowed: string[] = [];
	for (const ts of walkTestSources(opts.root)) {
		const js = `${ts.slice(0, -3)}.js`;
		if (existsSync(js)) shadowed.push(ts);
	}
	return shadowed;
}

export default function setup(): void {
	const shadowed = findShadowedTestSources({ root: testsRoot });
	if (shadowed.length === 0) return;

	const rel = (p: string) => p.slice(repoRoot.length + 1).replace(/\\/g, "/");
	const shown = shadowed
		.slice(0, 10)
		.map((ts) => `${rel(ts)} (shadowed by stale ${rel(`${ts.slice(0, -3)}.js`)})`);
	const more =
		shadowed.length > 10 ? `\n  …and ${shadowed.length - 10} more` : "";
	throw new Error(
		`\n⛔ Stale compiled .js shadowing test source: ${shadowed.length} file(s).\n` +
			`tests/ is excluded from \`npm run build\` and hidden from \`git status\` by\n` +
			`.gitignore's blanket \`*.js\` rule, but the import specifier ends in \`.js\`,\n` +
			`so Node resolves the stale compiled file over the .ts source it shadows.\n` +
			`Delete the .js file(s):\n  ${shown.join("\n  ")}${more}\n`,
	);
}
