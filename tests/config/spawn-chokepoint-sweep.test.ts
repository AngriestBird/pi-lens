/**
 * #4530: every runtime process start goes through the spawn chokepoint, or
 * carries a reasoned admission.
 *
 * ## The recurrence this guards
 *
 * `safeSpawnAsync`/`safeSpawn` (`clients/safe-spawn.ts`) judge every start
 * against project trust before they resolve or start anything: the child's
 * search path loses the session repository's own directories, and a bare
 * lookup that still resolves into the project is refused. A raw
 * `node:child_process` start never reaches that judgment. #4566 met that
 * nineteen times, one review per caller (a lazy `gem install`, `rustup
 * component add`, an interpreter's `-m site --user-base` probe, the pip
 * follow-up probe, the archive extraction), because guarding callers one by
 * one cannot converge: a new caller is a new hole. This sweep enumerates the
 * population instead, and makes every member either routed or admitted here
 * with a reason, a pinned site count and liveness evidence.
 *
 * ## Fail closed (defect shape 69)
 *
 * The population is derived from the `child_process` module binding itself,
 * never from a list of spellings: named imports (aliased or not), namespace and
 * default imports, and `require` (destructured, renamed or whole). Then every
 * reference to a bound name must be a CALL (`spawn(`, `cp.spawn(`). A bound name
 * used any other way (`const run = spawn`, passed as an argument, a property
 * read off the namespace) is reported as unclassified, and so is a module
 * specifier no recognised statement binds (a dynamic `import()`), unless it is
 * type-only. Comments and strings are blanked before any of this is read, so a
 * comment cannot add or hide a start.
 *
 * Each admission pins its site count, compared to the live count in both
 * directions, and names evidence the file's CODE must still carry (comments
 * blanked; strings kept, because a fixed system literal such as `taskkill` is
 * the evidence for some of them).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";
import { escapeRegExp } from "../../clients/string-utils.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The shipped runtime, the only population the invariant governs. */
const RUNTIME_ROOTS = ["clients", "tools", "mcp"] as const;

/** `node:child_process` members that start a process. */
const PROCESS_MEMBERS = [
	"fork",
	"spawn",
	"spawnSync",
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
] as const;

/**
 * The unref'd collector (`clients/child-unref.ts`) starts a process on its
 * caller's behalf, so a call of it is a start too.
 */
const WRAPPER_CALLEE = "spawnCollectStdoutResult";

interface Admission {
	/** Why this start does not route through the chokepoint. */
	reason: string;
	/** How many start sites the file has under this key, compared exactly. */
	sites: number;
	/** Code the file must still carry (comments blanked, strings kept). */
	evidence: string;
}

/**
 * Reasoned exceptions, keyed `repo-relative path#callee`. Each answers a
 * question the chokepoint does not ask, or cannot be reached by it.
 */
const ADMITTED: Readonly<Record<string, Admission>> = {
	"clients/safe-spawn.ts#spawn": {
		reason:
			"the chokepoint's own child start (safeSpawnAsync runs admitSpawn before it resolves or starts anything) and its fixed %SystemRoot% taskkill teardown literal",
		sites: 2,
		evidence: "admitSpawn(",
	},
	"clients/safe-spawn.ts#spawnSync": {
		reason:
			"the chokepoint's own synchronous start (safeSpawn runs admitSpawn first) plus its fixed %SystemRoot% taskkill and chcp teardown literals",
		sites: 4,
		evidence: "admitSpawn(",
	},
	"clients/lsp/launch.ts#nodeSpawn": {
		reason:
			"the LSP launcher's own starts (trySpawn's shell and direct arms): its PATH scan and child PATH are trust-scoped (trustScopedEnvironment), a bare command resolving into the project is refused (refuseProjectLookup), and the served-root project-local gate (#4248) runs on top; plus its fixed %SystemRoot% taskkill teardown literal",
		sites: 3,
		evidence: "refuseProjectLookup(command, spawnCommand, cwd, env)",
	},
	"clients/lsp/client.ts#nodeSpawn": {
		reason:
			"a fixed %SystemRoot% taskkill literal that tears down a language server this process already started",
		sites: 1,
		evidence: "taskkill",
	},
	"clients/instance-reaper.ts#nodeSpawn": {
		reason:
			"a fixed system taskkill literal in the reaper's failure path, which already reports an unverified kill",
		sites: 1,
		evidence: "taskkill",
	},
	"clients/child-unref.ts#nodeSpawn": {
		reason:
			"the unref'd collector cannot import the seam (safe-spawn depends on it), and its callers pass only fixed system process-table queries",
		sites: 1,
		evidence: "export function spawnCollectStdoutResult(",
	},
	"clients/process-snapshot.ts#spawnCollectStdoutResult": {
		reason:
			"process-table queries through the unref'd collector with fixed ps/wmic/PowerShell literals; a refused query yields no rows, never a wrong kill",
		sites: 2,
		evidence: "buildProcessQuery",
	},
	"clients/mcp/review.ts#spawn": {
		reason:
			"the analyze worker's interpreter is the running node (`process.execPath`), an absolute file this process already runs, never a search-path lookup",
		sites: 1,
		evidence: "spawn(process.execPath",
	},
};

/**
 * Files whose code names the module in a way that binds nothing, with how many
 * such mentions each has (compared exactly) and why.
 */
const UNBOUND_MENTIONS: Readonly<
	Record<string, { mentions: number; reason: string }>
> = {
	"clients/tree-sitter-client.ts": {
		mentions: 1,
		reason:
			"a tree-sitter rule compares a captured import specifier with the text child_process; it reads analysed code and binds no module",
	},
};

const SPECIFIER = /["'](?:node:)?child_process["']/g;
const IDENT = "[A-Za-z_$][\\w$]*";

interface ScanResult {
	/** `callee` (the local name, or `namespace.member`) → 1-based lines. */
	sites: Map<string, number[]>;
	/** References this reader could not place, with a line. */
	unclassified: string[];
	/** Specifier mentions no recognised statement binds. */
	unboundMentions: number;
}

function lineAt(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/** `text` with `[start, end)` blanked, keeping line breaks. */
function blankRange(text: string, start: number, end: number): string {
	return (
		text.slice(0, start) +
		text.slice(start, end).replace(/[^\n]/g, " ") +
		text.slice(end)
	);
}

/**
 * Process starts in one source file. `file` is repo-relative and only used in
 * the reported text, so the planted cases below drive this directly.
 */
function scanProcessStarts(file: string, source: string): ScanResult {
	const raw = source.replace(/\r\n/g, "\n");
	// Specifiers are strings: read them with comments blanked, strings kept.
	const withStrings = stripSource(raw, { strings: "keep" });
	// Name references are code: read them with strings blanked too.
	let code = stripSource(raw);
	const members = new Set<string>();
	const namespaces = new Set<string>();
	const unclassified: string[] = [];
	const boundSpecifiers = new Set<number>();
	const claim = (statement: RegExpMatchArray): void => {
		const at = statement.index ?? 0;
		for (const spec of statement[0].matchAll(SPECIFIER))
			boundSpecifiers.add(at + (spec.index ?? 0));
		code = blankRange(code, at, at + statement[0].length);
	};

	for (const statement of withStrings.matchAll(
		/import\s+(type\s+)?([^;]*?)\s+from\s+["'](?:node:)?child_process["']/g,
	)) {
		claim(statement);
		if (statement[1]) continue;
		const clause = statement[2] ?? "";
		const named = /\{([\s\S]*?)\}/.exec(clause);
		if (named) {
			for (const entry of (named[1] ?? "").split(",")) {
				const cleaned = entry.trim();
				if (!cleaned || /^type\s/.test(cleaned)) continue;
				const [imported = "", local] = cleaned.split(/\s+as\s+/);
				const name = (local ?? imported).trim();
				if (imported.trim() === "default") namespaces.add(name);
				else if (
					(PROCESS_MEMBERS as readonly string[]).includes(imported.trim())
				)
					members.add(name);
			}
		}
		const namespace = new RegExp(`\\*\\s+as\\s+(${IDENT})`).exec(clause);
		if (namespace?.[1]) namespaces.add(namespace[1]);
		const defaultImport = new RegExp(`^\\s*(${IDENT})\\s*(?:,|$)`).exec(clause);
		if (defaultImport?.[1]) namespaces.add(defaultImport[1]);
	}

	for (const statement of withStrings.matchAll(
		/(?:const|let|var)\s+([^=;]+?)=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g,
	)) {
		claim(statement);
		const target = (statement[1] ?? "").trim();
		const destructured = /^\{([\s\S]*)\}$/.exec(target);
		if (destructured) {
			// Known-good entries only, `name` or `name: local` (#4776 review): a
			// rest element or a nested pattern binds the module under a name this
			// reader would never follow, so it is reported. (A default's `=` never
			// reaches here: the statement pattern stops at it, and the specifier
			// is reported as unbound.)
			const entryForm = new RegExp(`^(${IDENT})(?:\\s*:\\s*(${IDENT}))?$`);
			for (const entry of (destructured[1] ?? "").split(",")) {
				const cleaned = entry.trim();
				if (!cleaned) continue;
				const form = entryForm.exec(cleaned);
				if (!form) {
					unclassified.push(
						`${file}:${lineAt(raw, statement.index ?? 0)}: a require of child_process destructured to an entry this reader cannot follow`,
					);
					continue;
				}
				const [, imported = "", local] = form;
				if ((PROCESS_MEMBERS as readonly string[]).includes(imported))
					members.add(local ?? imported);
			}
			continue;
		}
		if (new RegExp(`^${IDENT}$`).test(target)) namespaces.add(target);
		else
			unclassified.push(
				`${file}:${lineAt(raw, statement.index ?? 0)}: a require of child_process bound to a pattern this reader cannot follow`,
			);
	}

	// `typeof import("node:child_process")` starts nothing.
	for (const statement of withStrings.matchAll(
		/typeof\s+import\(\s*["'](?:node:)?child_process["']\s*\)/g,
	))
		claim(statement);

	const unbound = [...withStrings.matchAll(SPECIFIER)].filter(
		(spec) => !boundSpecifiers.has(spec.index ?? 0),
	);
	const admittedUnbound = UNBOUND_MENTIONS[file]?.mentions;
	for (const spec of admittedUnbound === unbound.length ? [] : unbound) {
		unclassified.push(
			`${file}:${lineAt(raw, spec.index ?? 0)}: an unplaceable child_process reference: bind the module (import, namespace import, or require) so the scan can follow it`,
		);
	}

	const sites = new Map<string, number[]>();
	const add = (callee: string, line: number): void => {
		const lines = sites.get(callee) ?? [];
		lines.push(line);
		sites.set(callee, lines);
	};
	const references = (name: string): IterableIterator<RegExpMatchArray> =>
		code.matchAll(
			new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g"),
		);

	for (const name of members) {
		for (const ref of references(name)) {
			const at = ref.index ?? 0;
			const after = code.slice(at + name.length);
			if (/^\s*\(/.test(after)) add(name, lineAt(raw, at));
			else
				unclassified.push(
					`${file}:${lineAt(raw, at)}: ${name} (a child_process start) is used other than by a call; an alias or a passed reference hides its starts`,
				);
		}
	}
	const memberCall = new RegExp(
		`^\\s*\\.\\s*(${PROCESS_MEMBERS.join("|")})\\s*\\(`,
	);
	for (const name of namespaces) {
		for (const ref of references(name)) {
			const at = ref.index ?? 0;
			const call = memberCall.exec(code.slice(at + name.length));
			if (call?.[1]) add(`${name}.${call[1]}`, lineAt(raw, at));
			else
				unclassified.push(
					`${file}:${lineAt(raw, at)}: ${name} (the child_process module) is used other than by a start call`,
				);
		}
	}
	for (const ref of references(WRAPPER_CALLEE)) {
		const at = ref.index ?? 0;
		const before = code.slice(Math.max(0, at - 20), at);
		const after = code.slice(at + WRAPPER_CALLEE.length);
		if (/function\s+$/.test(before)) continue; // its own declaration
		if (/^\s*\(/.test(after)) add(WRAPPER_CALLEE, lineAt(raw, at));
		else if (!/(?:import|export)\s*\{[^}]*$/.test(code.slice(0, at)))
			unclassified.push(
				`${file}:${lineAt(raw, at)}: ${WRAPPER_CALLEE} is used other than by a call`,
			);
	}
	return { sites, unclassified, unboundMentions: unbound.length };
}

/**
 * Whether `source`'s code still carries `evidence`: comments blanked, so a
 * comment quoting the evidence cannot keep an admission alive; strings kept,
 * because a fixed literal is the evidence for some admissions.
 */
function carriesEvidence(source: string, evidence: string): boolean {
	return stripSource(source, { strings: "keep" }).includes(evidence);
}

function runtimeFiles(): string[] {
	const files = RUNTIME_ROOTS.flatMap((root) =>
		listSourceFiles(path.join(REPO_ROOT, root), {
			extensions: [".ts"],
			skipTests: true,
		}),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files.sort();
}

function census(files: readonly string[]): {
	counts: Map<string, number>;
	details: Map<string, string>;
	unclassified: string[];
	scanned: number;
	sources: Map<string, string>;
	unbound: Map<string, number>;
} {
	const counts = new Map<string, number>();
	const unbound = new Map<string, number>();
	const details = new Map<string, string>();
	const sources = new Map<string, string>();
	const unclassified: string[] = [];
	let scanned = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		scanned += 1;
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		sources.set(relative, source);
		const result = scanProcessStarts(relative, source);
		unclassified.push(...result.unclassified);
		if (result.unboundMentions > 0)
			unbound.set(relative, result.unboundMentions);
		for (const [callee, lines] of result.sites) {
			const key = `${relative}#${callee}`;
			counts.set(key, lines.length);
			details.set(key, `${key} at ${lines.join(", ")}`);
		}
	}
	return { counts, details, unclassified, scanned, sources, unbound };
}

describe("spawn chokepoint sweep (#4530)", () => {
	const live = census(runtimeFiles());

	it("routes every runtime process start, or admits it with a reason", () => {
		assertNonEmptyScan("spawn chokepoint sweep", live.scanned, 300);
		const audit = auditRegistry({
			sweepName: "spawn chokepoint sweep",
			flagged: [...live.details].map(([key, detail]) => ({ key, detail })),
			registered: [],
			exemptions: Object.fromEntries(
				Object.entries(ADMITTED).map(([key, value]) => [key, value.reason]),
			),
			scannedCount: live.scanned,
			minScanned: 300,
			minFlagged: Object.keys(ADMITTED).length,
			remediation:
				"route the start through safeSpawnAsync/safeSpawn, or add a reasoned entry to ADMITTED with its site count and evidence",
		});
		expect(audit.problems).toEqual([]);
		// An unplaceable reference is a hole the scan cannot see through.
		expect(live.unclassified).toEqual([]);
	});

	it("pins each admission's site count, so an added or removed start reds", () => {
		const drift = Object.entries(ADMITTED)
			.filter(([key, admission]) => live.counts.get(key) !== admission.sites)
			.map(
				([key, admission]) =>
					`${key}: pinned ${admission.sites}, found ${live.counts.get(key) ?? 0}`,
			);
		expect(drift).toEqual([]);
	});

	it("keeps every unbound-mention admission live and exact", () => {
		const drift = Object.entries(UNBOUND_MENTIONS)
			.filter(
				([file, admitted]) => live.unbound.get(file) !== admitted.mentions,
			)
			.map(
				([file, admitted]) =>
					`${file}: admitted ${admitted.mentions}, found ${live.unbound.get(file) ?? 0}`,
			);
		expect(drift).toEqual([]);
	});

	it("keeps every admission's evidence in its file's code", () => {
		const missing: string[] = [];
		for (const [key, admission] of Object.entries(ADMITTED)) {
			expect(admission.reason.length, key).toBeGreaterThan(40);
			const file = key.slice(0, key.indexOf("#"));
			const source = live.sources.get(file);
			if (source === undefined) {
				missing.push(`${file}: admitted but not in the runtime population`);
				continue;
			}
			if (!carriesEvidence(source, admission.evidence))
				missing.push(`${file}: evidence "${admission.evidence}" is gone`);
		}
		expect(missing).toEqual([]);
	});

	it("runs the admission in both chokepoint bodies before their start", () => {
		// Liveness of the rule itself: the judgment sits where the seam starts
		// processes, so a refactor cannot leave the sweep screening a seam that
		// no longer judges anything.
		const source = stripSource(live.sources.get("clients/safe-spawn.ts") ?? "");
		for (const seam of [
			"export async function safeSpawnAsync(",
			"export function safeSpawn(",
		]) {
			const start = source.indexOf(seam);
			expect(start, seam).toBeGreaterThan(-1);
			const body = source.slice(
				start,
				source.indexOf("\nexport ", start + seam.length),
			);
			const admit = body.indexOf("admitSpawn(");
			const spawnAt = body.search(/\b(?:spawn|spawnSync)\(/);
			expect(admit, `${seam} runs admitSpawn`).toBeGreaterThan(-1);
			expect(spawnAt, `${seam} starts a child`).toBeGreaterThan(-1);
			expect(admit, `${seam} admits before it starts`).toBeLessThan(spawnAt);
		}
	});

	describe("planted sources (defect shape 69)", () => {
		const scan = (lines: string[]): ScanResult =>
			scanProcessStarts("clients/planted.ts", lines.join("\n"));
		// A planted `require` line, built from parts: the flake-shape scan keeps
		// string text, and a literal require of the module in this file would
		// count as this file's own real-process import.
		const requireLine = (binding: string): string =>
			`const ${binding} = require(${JSON.stringify("node:child_process")});`;

		it("flags a raw start in a file with no admission", () => {
			const result = scan([
				'import { spawn } from "node:child_process";',
				"export function run() { return spawn(process.execPath, []); }",
			]);
			expect([...result.sites]).toEqual([["spawn", [2]]]);
			expect(result.unclassified).toEqual([]);
		});

		it("follows aliased, namespace, default and required bindings", () => {
			const cases: Array<[string, string[], string]> = [
				[
					"aliased",
					[
						'import { spawn as nodeSpawn } from "node:child_process";',
						'nodeSpawn("a", []);',
					],
					"nodeSpawn",
				],
				[
					"namespace",
					[
						'import * as cp from "node:child_process";',
						'cp.spawnSync("a", []);',
					],
					"cp.spawnSync",
				],
				[
					"default",
					['import cp from "child_process";', 'cp.exec("a");'],
					"cp.exec",
				],
				[
					"destructured require",
					[requireLine("{ spawn: run }"), 'run("a", []);'],
					"run",
				],
				["required namespace", [requireLine("cp"), 'cp.fork("a");'], "cp.fork"],
				[
					"require in a function",
					[
						"export function probe() {",
						` ${requireLine("{ execFileSync }")}`,
						' return execFileSync("a", []);',
						"}",
					],
					"execFileSync",
				],
			];
			for (const [name, lines, callee] of cases) {
				const result = scan(lines);
				expect([...result.sites.keys()], name).toEqual([callee]);
				expect(result.unclassified, name).toEqual([]);
			}
		});

		it("reports an alias or a passed reference instead of losing its starts", () => {
			for (const lines of [
				[
					'import { spawn } from "node:child_process";',
					"const run = spawn;",
					'run("a", []);',
				],
				['import { spawn } from "node:child_process";', "launch(spawn);"],
				[
					'import * as cp from "node:child_process";',
					"const { spawn } = cp;",
					'spawn("a", []);',
				],
			]) {
				const result = scan(lines);
				expect(result.unclassified.length, lines.join(" ")).toBeGreaterThan(0);
			}
		});

		// #4776 review G3: these entries consumed the module reference and
		// registered nothing, so `cp.spawn` below was neither a site nor a report.
		it("reports a destructured require entry it cannot follow", () => {
			for (const binding of [
				"{ ...cp }",
				"{ spawn, ...rest }",
				"{ spawn: { call } }",
			]) {
				const result = scan([
					requireLine(binding),
					"cp.spawn(process.execPath, []);",
				]);
				expect(result.unclassified, binding).toEqual([
					"clients/planted.ts:1: a require of child_process destructured to an entry this reader cannot follow",
				]);
			}
		});

		it("reports a dynamic import it cannot bind", () => {
			const result = scan([
				'const loader = () => import("node:child_process");',
				"loader().then((m) => m.spawn(process.execPath, []));",
			]);
			expect(result.unclassified).toHaveLength(1);
			expect(result.unclassified[0]).toContain(
				"unplaceable child_process reference",
			);
		});

		it("never counts a comment or a string as a start or a binding", () => {
			const result = scan([
				'// import { spawn } from "node:child_process"; spawn("a", [])',
				'const text = "spawn(node:child_process)";',
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
		});

		it("keeps a type-only import out of the population", () => {
			const result = scan([
				'import type { ChildProcess } from "node:child_process";',
				'import { type SpawnOptions } from "node:child_process";',
				'type Cp = typeof import("node:child_process");',
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
		});

		it("cannot keep an admission alive with a comment that quotes its evidence", () => {
			expect(
				carriesEvidence("// admitSpawn(\nexport const x = 1;\n", "admitSpawn("),
			).toBe(false);
			expect(carriesEvidence('const k = "taskkill";\n', "taskkill")).toBe(true);
		});
	});
});
