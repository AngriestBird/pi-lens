/**
 * The shared Vitest setup file must not load production modules beyond a
 * small leaf allowlist (#3703).
 *
 * Recurrence it prevents: `tests/support/vitest-setup.ts` runs in every
 * worker BEFORE the test file, so every module it imports is cached before
 * the file's `vi.mock` registers. PR #3703 round 1 imported
 * `clients/instance-registry.js` there, which reached about 30 production
 * modules; each of the 56 files that mocks one of them (file-utils,
 * latency-logger, safe-spawn, ...) then got the real module through the
 * cached graph and went red in CI.
 *
 * The walk follows static relative imports through comment- and
 * string-blanked text, so a specifier quoted in a comment or a string
 * literal is not an edge. `import type` declarations are skipped: they load
 * nothing at runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import { stripSource } from "../support/sweep-kit.js";

const SETUP_FILE = "tests/support/vitest-setup.ts";

/** Production roots, as the Mutation diff lane defines them. */
const PRODUCTION = /^(?:clients|tools|mcp)\/|^index\.ts$/;

/** The only production modules the setup may load, each with its reason. */
const LEAF_ALLOWLIST: Readonly<Record<string, string>> = {
	"clients/instance-registry-tail.ts":
		"the registry mutation tail the teardown joins (#3617); imports only process-singletons",
	"clients/bounded-cache.ts":
		"kill-guard's bounded pid map (#2042); no imports, and no test mocks it",
	"clients/process-singletons.ts":
		"no static imports at all; reached only through the tail",
};

// Static forms only: `import … from`, `export … from`, and a bare side-effect
// `import "…"`. A dynamic `import()` loads when it is called, after the test
// file's mocks registered, so it cannot preload a module (the reason the
// setup's own helpers reach heavier modules lazily).
const SPECIFIER =
	/\bfrom\s*["'](\.\.?\/[^"']+)["']|\bimport\s*["'](\.\.?\/[^"']+)["']/g;
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']/g;

function resolveSpecifier(
	fromFile: string,
	specifier: string,
): string | undefined {
	const base = path.resolve(path.dirname(fromFile), specifier);
	// `nodenext`: `./x.js` names the source `./x.ts` beside the built `.js`.
	const candidates = [
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.mjs$/, ".mts"),
		base,
		`${base}.ts`,
		path.join(base, "index.ts"),
	];
	return candidates.find(
		(candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
	);
}

/** Repo-relative modules `source` imports, from code only. */
export function importEdges(file: string, source: string): string[] {
	// Specifiers are string literals, so they are read from the keep-strings
	// text; the keyword must survive the blank-strings text, which drops any
	// `from "…"` that is itself inside a comment or a string.
	const keep = stripSource(source, { strings: "keep" });
	const code = stripSource(source, { strings: "blank" });
	const typeOnly = [...keep.matchAll(TYPE_ONLY)].map((match) => [
		match.index,
		match.index + match[0].length,
	]);
	const edges: string[] = [];
	for (const match of keep.matchAll(SPECIFIER)) {
		if (code.slice(match.index, match.index + 4).trim() === "") continue;
		if (
			typeOnly.some(([start, end]) => match.index >= start && match.index < end)
		)
			continue;
		const resolved = resolveSpecifier(file, match[1] ?? match[2] ?? "");
		if (resolved) edges.push(resolved);
	}
	return edges;
}

function closure(entry: string): string[] {
	const seen = new Set<string>();
	const queue = [path.join(repoRoot, entry)];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		queue.push(...importEdges(file, fs.readFileSync(file, "utf8")));
	}
	return [...seen].map((file) =>
		path.relative(repoRoot, file).split(path.sep).join("/"),
	);
}

describe("shared Vitest setup import closure (#3703)", () => {
	it("loads no production module outside the leaf allowlist, and every allowlist entry is still reached", () => {
		const production = closure(SETUP_FILE)
			.filter((file) => PRODUCTION.test(file))
			.sort();
		expect(production).toEqual(Object.keys(LEAF_ALLOWLIST).sort());
	});

	it("reads edges from code, not from comments or strings", () => {
		const file = path.join(repoRoot, SETUP_FILE);
		const source = [
			'// import { x } from "../../clients/instance-registry.js";',
			"const text = 'import { y } from \"../../clients/file-utils.js\"';",
			'import type { Z } from "../../clients/latency-logger.js";',
			'import { settle } from "../../clients/instance-registry-tail.js";',
		].join("\n");
		expect(
			importEdges(file, source).map((edge) => path.relative(repoRoot, edge)),
		).toEqual([path.join("clients", "instance-registry-tail.ts")]);
	});
});
