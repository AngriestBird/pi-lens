import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// Repo-root derived, NOT process.cwd() (#1718 hazard verbatim: a
// cwd-relative walk root reads clean the moment the runner's working
// directory shifts, because readdirSync on a wrong-but-existing directory
// just silently returns fewer or zero files instead of erroring).
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS = path.join(REPO_ROOT, "clients");
const ENSURE_WRAPPERS = new Set([
	"dispatch/runners/utils/runner-helpers.ts",
	"formatters.ts",
	"installer/index.ts",
	"lsp/server.ts",
	"mcp/session.ts",
	"runtime-session.ts",
	"security-scan-client.ts",
]);
const MANAGED_COMMANDS = new Set([
	"ast-grep",
	"biome",
	"jscpd",
	"knip",
	"madge",
	"ruff",
	"sg",
]);

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory()
			? sourceFiles(full)
			: entry.isFile() && entry.name.endsWith(".ts")
				? [full]
				: [];
	});
}

describe("managed-tool client seam coverage (#1290)", () => {
	it("keeps ensureTool and bare managed-tool spawns behind shared wrappers", () => {
		const files = sourceFiles(CLIENTS);
		// Registered-or-fail floor (#1718 lesson): a walk that silently found
		// zero files must fail loud, not read as "zero violations = clean".
		// 393 .ts files under clients/ measured 2026-08-26; half rounded up
		// is 197, rounded up further to a round number.
		assertNonEmptyScan(
			"managed-tool-seam-coverage: clients/ files scanned",
			files.length,
			200,
		);

		const violations: string[] = [];
		let ensureToolSignal = 0;
		for (const file of files) {
			const relative = path.relative(CLIENTS, file).split(path.sep).join("/");
			const source = fs
				.readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|\s)\/\/.*$/gm, "$1");
			const ensureToolCalls = source.match(/\bensureTool\s*\(/g);
			if (ensureToolCalls) ensureToolSignal += ensureToolCalls.length;
			if (!ENSURE_WRAPPERS.has(relative) && /\bensureTool\s*\(/.test(source)) {
				violations.push(`${relative}: direct ensureTool()`);
			}
			for (const match of source.matchAll(
				/\bsafeSpawnAsync\s*\(\s*["']([^"']+)["']/g,
			)) {
				if (
					MANAGED_COMMANDS.has(match[1]) &&
					relative !== "dispatch/runners/utils/runner-helpers.ts"
				) {
					violations.push(`${relative}: bare managed spawn ${match[1]}`);
				}
			}
		}
		// Positive-control floor: proves the ensureTool( detector itself can
		// still match SOMETHING (the wrapper files' own legitimate calls), so
		// a zero-violations result means "nothing outside the wrappers calls
		// it", not "the regex stopped matching anything at all". 25 calls
		// measured 2026-08-26; half rounded up is 13.
		assertNonEmptyScan(
			"managed-tool-seam-coverage: ensureTool( detector signal",
			ensureToolSignal,
			13,
		);
		expect(violations).toEqual([]);
	});
});
