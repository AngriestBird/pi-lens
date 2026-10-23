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
 * read off the parsed source (`@ast-grep/napi`, through the AST census seam),
 * never from a list of spellings. Every literal that names the module must sit
 * in an ADMITTED binding form (see `scanProcessStarts`); any other form that
 * names it (a string-named specifier, a re-export, a require inside an
 * expression, a dynamic `import()`) is reported. Then every reference to a
 * bound name must be a CALL (`spawn(`, `cp.spawn(`). A bound name used any
 * other way (`const run = spawn`, passed as an argument, a property read off
 * the namespace) is reported as unclassified. Comments are not code and a
 * string's text is not a binding, so neither can add or hide a start (#4776
 * review H2: the text reader this replaced missed a string-named specifier and
 * a require inside template text, the second round of missed spellings).
 *
 * Each admission pins its site count, compared to the live count in both
 * directions, and names evidence the file's CODE must still carry (comments
 * blanked; strings kept, because a fixed system literal such as `taskkill` is
 * the evidence for some of them).
 */

import * as path from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseNodes } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

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

const MODULE_NAMES: ReadonlySet<string> = new Set([
	"child_process",
	"node:child_process",
]);

interface ScanResult {
	/** `callee` (the local name, or `namespace.member`) → 1-based lines. */
	sites: Map<string, number[]>;
	/** References this reader could not place, with a line. */
	unclassified: string[];
	/** Module mentions no admitted form places. */
	unboundMentions: number;
}

/**
 * A node's identity within one parse: its byte range and kind (a parent and
 * its only child can share a range, never a kind).
 */
function nodeId(node: SgNode): string {
	const { start, end } = node.range();
	return `${start.index}:${end.index}:${String(node.kind())}`;
}

function lineOf(node: SgNode): number {
	return node.range().start.line + 1;
}

/** Punctuation and comments: the only children a recognised form may carry besides its parts. */
const INERT_KINDS: ReadonlySet<string> = new Set([
	"{",
	"}",
	",",
	"(",
	")",
	"comment",
]);

/**
 * The module name a literal spells, when the WHOLE literal is one: a string,
 * or a template with no substitution. Text inside a longer string or template
 * is prose, never a mention, and a substitution's code is parsed as code.
 */
function literalModuleName(node: SgNode): string | undefined {
	const kind = String(node.kind());
	if (kind !== "string" && kind !== "template_string") return undefined;
	const text = node.text();
	if (kind === "template_string" && text.includes("${")) return undefined;
	const value = text.slice(1, -1);
	return MODULE_NAMES.has(value) ? value : undefined;
}

/**
 * Process starts in one source file. `file` is repo-relative and only used in
 * the reported text, so the planted cases below drive this directly.
 *
 * #4776 review H2 (the second round that found a spelling the text reader
 * missed): the source is parsed, and the reader ADMITS a short list of binding
 * forms. Every other node that names the module is reported, so a spelling
 * nobody planned for fails closed:
 *
 * - `import` with a default, namespace or named clause whose specifiers are
 *   identifiers (`spawn`, `spawn as x`, `default as cp`, `type X`), a
 *   side-effect `import`, and `import type`;
 * - `const <name | { member, member: local }> = require(<module>)`;
 * - `typeof import(<module>)`, which starts nothing.
 *
 * A bound name must then be used only as a call (`spawn(`, `cp.spawn(`).
 */
function scanProcessStarts(file: string, source: string): ScanResult {
	// A cheap text narrowing, never the decision: a literal that names the
	// module contains its name, and a wrapper call contains the wrapper's. A
	// file with neither binds nothing, and skipping its parse keeps the census
	// to the few files that can (parsing every runtime file held a native tree
	// per file and peaked over the 2 GB worker budget in CI). Stated bound: a
	// module name built at run time or spelled with escapes is not a literal
	// this reader sees.
	if (!source.includes("child_process") && !source.includes(WRAPPER_CALLEE))
		return { sites: new Map(), unclassified: [], unboundMentions: 0 };
	const nodes = parseNodes(source.replace(/\r\n/g, "\n"));
	const kidsOf = new Map<string, SgNode[]>();
	for (const node of nodes) {
		const parent = node.parent();
		if (!parent) continue;
		const id = nodeId(parent);
		const kids = kidsOf.get(id) ?? [];
		kids.push(node);
		kidsOf.set(id, kids);
	}
	const kids = (node: SgNode): SgNode[] => kidsOf.get(nodeId(node)) ?? [];
	const same = (a: SgNode | null | undefined, b: SgNode): boolean =>
		a !== null && a !== undefined && nodeId(a) === nodeId(b);

	const members = new Set<string>();
	const namespaces = new Set<string>();
	const bindingNodes = new Set<string>();
	const unclassified: string[] = [];
	let unboundMentions = 0;
	const refuse = (node: SgNode, what: string): void => {
		unclassified.push(`${file}:${lineOf(node)}: ${what}`);
	};
	const bind = (target: Set<string>, local: SgNode): void => {
		target.add(local.text());
		bindingNodes.add(nodeId(local));
	};
	const bindMember = (imported: string, local: SgNode): void => {
		if ((PROCESS_MEMBERS as readonly string[]).includes(imported))
			bind(members, local);
		else bindingNodes.add(nodeId(local));
	};

	/** An `import … from <module>`: true when every part is a known form. */
	const readImport = (statement: SgNode): boolean => {
		const parts = kids(statement);
		if (parts.some((part) => String(part.kind()) === "type")) return true;
		const clause = parts.find(
			(part) => String(part.kind()) === "import_clause",
		);
		if (!clause) return true; // a side-effect import binds nothing
		for (const part of kids(clause)) {
			const kind = String(part.kind());
			if (kind === "identifier") bind(namespaces, part);
			else if (kind === "namespace_import") {
				const local = kids(part).find(
					(child) => String(child.kind()) === "identifier",
				);
				if (!local) return false;
				bind(namespaces, local);
			} else if (kind === "named_imports") {
				for (const entry of kids(part)) {
					const entryKind = String(entry.kind());
					if (INERT_KINDS.has(entryKind)) continue;
					if (entryKind !== "import_specifier") return false;
					if (kids(entry).some((k) => String(k.kind()) === "type")) continue;
					const name = entry.field("name");
					const alias = entry.field("alias");
					if (String(name?.kind()) !== "identifier" || !name) return false;
					if (alias && String(alias.kind()) !== "identifier") return false;
					const local = alias ?? name;
					if (name.text() === "default") bind(namespaces, local);
					else bindMember(name.text(), local);
				}
			} else if (!INERT_KINDS.has(kind)) return false;
		}
		return true;
	};

	/** `const <pattern> = require(<module>)`: true when the pattern is a known form. */
	const readRequire = (call: SgNode): boolean => {
		const declarator = call.parent();
		if (String(declarator?.kind()) !== "variable_declarator" || !declarator)
			return false;
		if (!same(declarator.field("value"), call)) return false;
		const target = declarator.field("name");
		if (!target) return false;
		if (String(target.kind()) === "identifier") {
			bind(namespaces, target);
			return true;
		}
		if (String(target.kind()) !== "object_pattern") return false;
		for (const entry of kids(target)) {
			const kind = String(entry.kind());
			if (INERT_KINDS.has(kind)) continue;
			if (kind === "shorthand_property_identifier_pattern") {
				bindMember(entry.text(), entry);
				continue;
			}
			if (kind !== "pair_pattern") return false;
			const key = entry.field("key");
			const value = entry.field("value");
			if (String(key?.kind()) !== "property_identifier" || !key) return false;
			if (String(value?.kind()) !== "identifier" || !value) return false;
			bindMember(key.text(), value);
		}
		return true;
	};

	for (const node of nodes) {
		if (literalModuleName(node) === undefined) continue;
		const parent = node.parent();
		const parentKind = String(parent?.kind());
		if (parent && parentKind === "import_statement") {
			if (!same(parent.field("source"), node) || !readImport(parent))
				refuse(
					parent,
					"an import of child_process with a binding this reader cannot follow",
				);
			continue;
		}
		const call = parent?.parent();
		const isSoleArgument =
			parent !== null &&
			parentKind === "arguments" &&
			kids(parent).every(
				(kid) => same(kid, node) || INERT_KINDS.has(String(kid.kind())),
			);
		if (call && isSoleArgument && String(call.kind()) === "call_expression") {
			const callee = call.field("function");
			const calleeKind = String(callee?.kind());
			if (calleeKind === "identifier" && callee?.text() === "require") {
				if (!readRequire(call))
					refuse(
						call,
						"a require of child_process bound to a pattern this reader cannot follow",
					);
				continue;
			}
			if (
				calleeKind === "import" &&
				String(call.parent()?.kind()) === "type_query"
			)
				continue; // `typeof import(…)` starts nothing
		}
		unboundMentions += 1;
	}
	const unbound = unboundMentions;
	if (UNBOUND_MENTIONS[file]?.mentions !== unbound) {
		for (let index = 0; index < unbound; index += 1) {
			unclassified.push(
				`${file}: an unplaceable child_process reference: bind the module (import, namespace import, or require) so the scan can follow it`,
			);
		}
	}

	const sites = new Map<string, number[]>();
	const add = (callee: string, node: SgNode): void => {
		const lines = sites.get(callee) ?? [];
		lines.push(lineOf(node));
		sites.set(callee, lines);
	};
	const isCallee = (node: SgNode): boolean => {
		const parent = node.parent();
		return (
			String(parent?.kind()) === "call_expression" &&
			same(parent?.field("function"), node)
		);
	};
	for (const node of nodes) {
		const kind = String(node.kind());
		const name = node.text();
		// #4776 verify V1: the wrapper is admitted in the same few forms as the
		// module binding (its declaration, an unaliased import or export, a
		// plain call); an alias or a member read (`u.spawnCollectStdoutResult`)
		// hides its starts, so it is reported.
		// Name-bearing nodes only: a specifier node spells the same text as the
		// identifier inside it.
		const namesNode =
			kind === "identifier" ||
			kind === "shorthand_property_identifier" ||
			kind === "property_identifier";
		if (namesNode && name === WRAPPER_CALLEE) {
			const parent = node.parent();
			const parentKind = String(parent?.kind());
			if (kind === "identifier" && isCallee(node)) add(WRAPPER_CALLEE, node);
			else if (
				kind === "identifier" &&
				parentKind === "function_declaration" &&
				same(parent?.field("name"), node)
			)
				continue;
			else if (
				kind === "identifier" &&
				(parentKind === "import_specifier" ||
					parentKind === "export_specifier") &&
				!parent?.field("alias")
			)
				continue;
			else refuse(node, `${WRAPPER_CALLEE} is used other than by a call`);
			continue;
		}
		if (kind !== "identifier" && kind !== "shorthand_property_identifier")
			continue;
		if (bindingNodes.has(nodeId(node))) continue;
		if (members.has(name)) {
			if (kind === "identifier" && isCallee(node)) add(name, node);
			else
				refuse(
					node,
					`${name} (a child_process start) is used other than by a call; an alias or a passed reference hides its starts`,
				);
			continue;
		}
		if (!namespaces.has(name)) continue;
		const access = node.parent();
		const property = access?.field("property");
		if (
			kind === "identifier" &&
			access &&
			String(access.kind()) === "member_expression" &&
			same(access.field("object"), node) &&
			property &&
			(PROCESS_MEMBERS as readonly string[]).includes(property.text()) &&
			isCallee(access)
		)
			add(`${name}.${property.text()}`, node);
		else
			refuse(
				node,
				`${name} (the child_process module) is used other than by a start call`,
			);
	}
	return { sites, unclassified, unboundMentions: unbound };
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

async function census(files: readonly string[]): Promise<{
	counts: Map<string, number>;
	details: Map<string, string>;
	unclassified: string[];
	scanned: number;
	sources: Map<string, string>;
	unbound: Map<string, number>;
}> {
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
		// AGENTS shape 81 (#4776 verify V3): a parsed tree is freed only when
		// the event loop turns, so the census turns it once per file.
		await new Promise<void>((resolve) => setImmediate(resolve));
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
	let live: Awaited<ReturnType<typeof census>>;
	beforeAll(async () => {
		live = await census(runtimeFiles());
	});

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
		const requireCall = `require(${JSON.stringify("node:child_process")})`;
		const requireLine = (binding: string): string =>
			`const ${binding} = ${requireCall};`;

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
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				]);
			}
		});

		// #4776 review H2: the text reader claimed each of these forms (or blanked
		// the code inside it) and registered nothing, so the start below it was
		// neither a site nor a report. The parsed reader admits only its known
		// binding forms, so each is refused.
		it("refuses every other form that names the module", () => {
			const cases: Array<[string, string[], string]> = [
				[
					"string-named import specifier",
					[
						'import { "spawn" as nodeSpawn } from "node:child_process";',
						"nodeSpawn(process.execPath, []);",
					],
					"clients/planted.ts:1: an import of child_process with a binding this reader cannot follow",
				],
				[
					"require inside template text",
					[`const shown = \`\${${requireCall}.spawn(process.execPath, [])}\`;`],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"import-shaped template text around a real require",
					[
						`const shown = \`import \${${requireCall}.spawn(process.execPath, [])} from "node:child_process"\`;`,
					],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"destructured require with a default",
					[requireLine("{ spawn = fallback }"), "spawn(process.execPath, []);"],
					"clients/planted.ts:1: a require of child_process bound to a pattern this reader cannot follow",
				],
				[
					"re-export",
					['export { spawn } from "node:child_process";'],
					"clients/planted.ts: an unplaceable child_process reference: bind the module (import, namespace import, or require) so the scan can follow it",
				],
				[
					"shorthand property passing a bound start",
					['import { spawn } from "node:child_process";', "launch({ spawn });"],
					"clients/planted.ts:2: spawn (a child_process start) is used other than by a call; an alias or a passed reference hides its starts",
				],
			];
			for (const [name, lines, report] of cases) {
				const result = scan(lines);
				expect(result.unclassified, name).toContain(report);
			}
		});

		// #4776 verify V1: both forms reached the collector with no site and
		// no report.
		it("refuses the collector under an aliased import", () => {
			const result = scan([
				'import { spawnCollectStdoutResult as collect } from "./child-unref.js";',
				'collect("ps", []);',
			]);
			expect(result.unclassified).toEqual([
				"clients/planted.ts:1: spawnCollectStdoutResult is used other than by a call",
			]);
		});

		it("refuses the collector as a namespace member call", () => {
			const result = scan([
				'import * as unref from "./child-unref.js";',
				'unref.spawnCollectStdoutResult("ps", []);',
			]);
			expect(result.unclassified).toEqual([
				"clients/planted.ts:2: spawnCollectStdoutResult is used other than by a call",
			]);
		});

		it("follows a plain call of the collector", () => {
			const result = scan([
				'import { spawnCollectStdoutResult } from "./child-unref.js";',
				'spawnCollectStdoutResult("ps", []);',
			]);
			expect([...result.sites]).toEqual([["spawnCollectStdoutResult", [2]]]);
			expect(result.unclassified).toEqual([]);
		});

		it("reads import-shaped text in a string or template as prose", () => {
			const result = scan([
				'const doc = `import { spawn } from "node:child_process"; spawn("a")`;',
				`const note = '${requireCall}.spawn("a")';`,
			]);
			expect([...result.sites]).toEqual([]);
			expect(result.unclassified).toEqual([]);
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
