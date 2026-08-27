/**
 * #1980 AC3, as a recurrence guard rather than a one-off census.
 *
 * A synchronous child-process call parks the event loop for exactly as long
 * as the child takes. With no `timeout`, that is unbounded — and #1980's
 * whole finding is that such a park used to read as ordinary compute in
 * `loop_block`, because `windowCpuMs` was recorded and never read.
 *
 * The one-off sweep found two unbounded sites (`findBinaryOnPath` in
 * clients/lsp/launch.ts, on the LSP spawn path, and
 * `ensureUtf8ConsoleCodePageOnce` in clients/safe-spawn.ts, on the first
 * spawn of the process). Both are fixed. This walks the family so the next
 * one cannot land silently: a hand-written list of "the sync spawn sites"
 * would go stale the first time someone adds one, which is the
 * single-source-of-truth rule this repo already applies to language and
 * runner registries.
 *
 * Scope: `spawnSync` / `execSync` / `execFileSync` CALL sites in the shipped
 * source tree (clients/, index.ts, tools/, mcp/). Tests and scripts are out —
 * neither runs on pi's event loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** The family. Each is a synchronous child-process launcher. */
const SYNC_SPAWN_CALLS = ["spawnSync", "execSync", "execFileSync"];

/**
 * Sites that legitimately carry no literal `timeout:` in their own options,
 * with the reason. Keyed by `file::enclosingSnippet` so a move is visible but
 * a rename of the surrounding function is not a false failure.
 *
 * Keep this SHORT and reasoned. "It is probably fast" is not a reason — the
 * two bugs this test exists for were both probably fast.
 */
const ALLOWED_WITHOUT_TIMEOUT: ReadonlyArray<{
	file: string;
	contains: string;
	reason: string;
}> = [
	{
		file: "clients/safe-spawn.ts",
		contains: "taskkill.exe",
		reason:
			"killPidTreeSync runs from process exit/signal handlers. The process is already tearing down, so there is no event loop left to protect and a timeout would only orphan the kill.",
	},
	{
		file: "clients/safe-spawn.ts",
		contains: "...(options as SpawnOptions)",
		reason:
			"safeSpawn's own two spawnSync calls spread the CALLER's options, which is where the timeout comes from; its only in-repo callers (isCommandAvailable, findCommand) both pass timeout: 5000.",
	},
];

function sourceFiles(): string[] {
	const roots = ["clients", "tools", "mcp"];
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist") continue;
				walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				found.push(full);
			}
		}
	};
	for (const root of roots) {
		const abs = path.join(repoRoot, root);
		if (fs.existsSync(abs)) walk(abs);
	}
	const indexTs = path.join(repoRoot, "index.ts");
	if (fs.existsSync(indexTs)) found.push(indexTs);
	return found;
}

/**
 * Slice from `(` to its matching `)`, so the options object is read whole
 * rather than by a line-bounded regex that a multi-line call defeats.
 */
function callArguments(source: string, openParenIndex: number): string {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openParenIndex + 1, i);
		}
	}
	return source.slice(openParenIndex + 1);
}

/**
 * Which byte offsets are real code, as opposed to comment or string body.
 *
 * Necessary, not fussy: this repo documents its own migrations in prose, so
 * `clients/lsp/server.ts` and `clients/safe-spawn.ts` both contain the text
 * `spawnSync(` inside doc comments explaining that the call USED to be
 * synchronous. A plain regex reports those as unbounded call sites, which is
 * a false failure that would push a maintainer to weaken this test. Stripping
 * comments with a regex has the opposite risk — it can swallow real code and
 * hide a genuine site — so this walks the file once and tracks state instead.
 */
function codeMask(source: string): Uint8Array {
	const mask = new Uint8Array(source.length).fill(1);
	let i = 0;
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to && k < source.length; k++) mask[k] = 0;
	};
	while (i < source.length) {
		const two = source.slice(i, i + 2);
		if (two === "//") {
			const end = source.indexOf("\n", i);
			const stop = end === -1 ? source.length : end;
			blank(i, stop);
			i = stop;
		} else if (two === "/*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
		} else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
			const quote = source[i];
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") j += 2;
				else if (source[j] === quote) break;
				else j++;
			}
			blank(i, Math.min(j + 1, source.length));
			i = j + 1;
		} else {
			i++;
		}
	}
	return mask;
}

interface CallSite {
	file: string;
	line: number;
	fn: string;
	args: string;
	/** Source just before the call, so an allowlist entry can key on the
	 * enclosing function rather than on the argument list alone. */
	context: string;
}

function findCallSites(): CallSite[] {
	const sites: CallSite[] = [];
	for (const abs of sourceFiles()) {
		const source = fs.readFileSync(abs, "utf-8");
		const mask = codeMask(source);
		const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
		for (const fn of SYNC_SPAWN_CALLS) {
			// A CALL, not an import/type/prose mention: the name must be
			// followed by `(`, and must not be preceded by an identifier char
			// (so `safeSpawnSync(` never matches `spawnSync`).
			const pattern = new RegExp(`(?<![\\w$.])${fn}\\s*\\(`, "g");
			for (const match of source.matchAll(pattern)) {
				if (mask[match.index] !== 1) continue; // comment or string body
				const openParen = source.indexOf("(", match.index);
				sites.push({
					file: rel,
					line: source.slice(0, match.index).split("\n").length,
					fn,
					args: callArguments(source, openParen),
					context: source.slice(Math.max(0, match.index - 600), match.index),
				});
			}
		}
	}
	return sites;
}

const matchesEntry = (
	site: CallSite,
	entry: (typeof ALLOWED_WITHOUT_TIMEOUT)[number],
): boolean =>
	entry.file === site.file &&
	(site.args.includes(entry.contains) || site.context.includes(entry.contains));

const isAllowed = (site: CallSite): boolean =>
	ALLOWED_WITHOUT_TIMEOUT.some((entry) => matchesEntry(site, entry));

describe("#1980 every synchronous child-process call bounds the event-loop park", () => {
	const sites = findCallSites();

	it("finds the family at all (guards against a regex that matches nothing)", () => {
		// Vacuity guard: if the detection breaks, every assertion below passes
		// for free. The repo had 7 such sites when this landed.
		expect(sites.length).toBeGreaterThanOrEqual(5);
		expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(3);
	});

	it("passes an explicit timeout, or is allowlisted with a reason", () => {
		const unbounded = sites
			.filter((site) => !/\btimeout\s*:/.test(site.args))
			.filter((site) => !isAllowed(site))
			.map((site) => `${site.file}:${site.line} ${site.fn}`);
		// Pre-fix this reads:
		//   clients/lsp/launch.ts:310 execFileSync
		//   clients/safe-spawn.ts:1062 spawnSync
		expect(unbounded).toEqual([]);
	});

	it("keeps the allowlist live, so a stale exemption cannot hide a new site", () => {
		// An allowlist entry whose site no longer exists must be deleted, not
		// left to silently cover some future call it was never reasoned about.
		const stale = ALLOWED_WITHOUT_TIMEOUT.filter(
			(entry) => !sites.some((site) => matchesEntry(site, entry)),
		).map((entry) => `${entry.file} :: ${entry.contains}`);
		expect(stale).toEqual([]);
	});
});
