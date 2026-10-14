/**
 * Governance: a test never reads a log sink before draining it (#4381).
 *
 * Every pi-lens log sink is a `createNdjsonLogger` writer: `log`/`append` only
 * ENQUEUE, and the queue drains through `fs.promises.appendFile`
 * (`clients/ndjson-logger.ts`). A test that takes a byte offset or a line
 * count of the sink file while one of its own writes is still queued counts
 * those late bytes on the wrong side of its window. #4381 is the third time:
 * `config-resolved-phase.test.ts` loaded config (two sessionstart lines
 * enqueued), then took `statSync(SESSIONSTART_LOG_FILE).size` with no
 * `flushSessionStartLog()`, and master run 38515888889 read "expected 0
 * lines, got 2". Earlier members of the class: #3682 (PR #3720), #3721 (PR
 * #3892), #3193. AGENTS.md "Data directories and logs" states the rule
 * ("Flush the specific logger before reading its file"); this sweep makes it
 * a check.
 *
 * The rule, per read: every `statSync` / `lstatSync` / `readFileSync` /
 * `readFile` / `createReadStream` call in `tests/**` whose first argument
 * names an in-process sink needs a drain OF THAT SINK earlier in its scope,
 * with no other `await` between the drain and the read (an await lets the
 * code under test enqueue more). A drain is the sink module's own `flush*`
 * export (awaited, or a `*Sync` variant), `flushAllNdjsonWriters()`, or an
 * awaited call to a local helper whose own body drains that sink. The scope
 * is the nearest enclosing function that is a declaration, a method, or a
 * test/hook callback; inline callbacks (`.map(...)`, `withHome(() => ...)`)
 * are transparent. A read inside a local helper with no drain of its own is
 * drained when every call site of the helper is.
 *
 * Detectors match code, not prose (#4381 acceptance; principles §2):
 * - The DRAIN needles run over `stripSource` text with strings and comments
 *   blanked, so a comment or string naming `flushSessionStartLog()` cannot
 *   satisfy a read (the self-excuse direction).
 * - The SINK needles are of two kinds. Exported path symbols
 *   (`SESSIONSTART_LOG_FILE`, `getLatencyLogPath()`) and local aliases of
 *   them match blanked text. Basename literals (`"latency.log"`) are string
 *   evidence by nature, so that one needle reads the comment-blanked,
 *   string-kept text, and counts only when the same expression names an
 *   in-process log root (`LOG_ROOT_SYMBOLS`): a comment naming a sink file
 *   creates no requirement, and a child process's `path.join(childHome,
 *   "latency.log")` is not an in-process sink.
 *
 * Both populations are DERIVED, not listed: the sink modules are every
 * `clients/` file that calls `createNdjsonLogger(` in code, and their path
 * symbols, flush exports, and basenames are read from those modules. A new
 * sink joins the sweep without an edit here (AGENTS.md shape 34).
 *
 * Known limits, named (all false negatives):
 * - A read whose path reaches the sink through a function parameter, a value
 *   computed in another module, or a directory a `vi.doMock` redirected
 *   (`tests/clients/lsp/launch.test.ts`) is invisible.
 * - A synchronous write between the drain and the read is not modelled. It
 *   cannot flake: its append needs a loop turn, so the read never sees it
 *   and a test that depends on it reds every run.
 * - A reader helper passed by reference (not called) has no call sites to
 *   check, so it is judged on its own body.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_ROOT = path.join(REPO_ROOT, "clients");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/sink-read-drain-sweep.test.ts";

/** One in-process sink module and the evidence a test can name it by. */
interface SinkModule {
	module: string;
	/** Exported path constants/getters, e.g. `SESSIONSTART_LOG_FILE`. */
	pathSymbols: string[];
	/** Exported drains, e.g. `flushSessionStartLog`. */
	flushSymbols: string[];
	/** File basenames the module writes, e.g. `sessionstart.log`. */
	basenames: string[];
}

/** Drains every registered writer at once (`clients/ndjson-logger.ts`). */
const GLOBAL_DRAINS = ["flushAllNdjsonWriters"];

/**
 * The in-process log roots. A basename literal names an in-process sink only
 * when its path expression also names one of these (directly or through a
 * local alias); `path.join(childHome, "latency.log")` names a child process's
 * file, which no in-process flush can drain. Pinned against drift by the
 * "every sink module roots its path in LOG_ROOT_SYMBOLS" case below.
 */
const LOG_ROOT_SYMBOLS = [
	"getGlobalPiLensLogDir",
	"getGlobalPiLensDir",
	"PI_LENS_HOME",
];

const EXPORTED_NAME =
	/\bexport\s+(?:async\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/g;
const PATH_SYMBOL = /(?:_FILE|_PATH)$|^get\w*Path$/;
const FLUSH_SYMBOL = /^flush\w*$/;
const BASENAME_LITERAL = /["'`]([\w-][\w.-]*\.(?:log|jsonl))["'`]/g;

function sinkModuleFromSource(
	module: string,
	source: string,
): SinkModule | undefined {
	const blanked = stripSource(source);
	if (!/\bcreateNdjsonLogger\s*\(/.test(blanked)) return undefined;
	// The factory's own module defines it; it is not a sink.
	if (/\bfunction\s+createNdjsonLogger\b/.test(blanked)) return undefined;
	const exported = [...blanked.matchAll(EXPORTED_NAME)].map((m) => m[1]);
	const kept = stripSource(source, { strings: "keep" });
	return {
		module,
		pathSymbols: exported.filter((name) => PATH_SYMBOL.test(name)),
		flushSymbols: exported.filter((name) => FLUSH_SYMBOL.test(name)),
		basenames: [
			...new Set([...kept.matchAll(BASENAME_LITERAL)].map((m) => m[1])),
		],
	};
}

function discoverSinkModules(): Array<SinkModule & { source: string }> {
	const sinks: Array<SinkModule & { source: string }> = [];
	for (const absolute of listSourceFiles(CLIENTS_ROOT, {
		extensions: [".ts"],
		skipTests: true,
	})) {
		const source = fs.readFileSync(absolute, "utf8");
		const sink = sinkModuleFromSource(
			relativePosix(REPO_ROOT, absolute),
			source,
		);
		if (sink) sinks.push({ ...sink, source });
	}
	return sinks;
}

/** One sink read with no drain of its sink before it. */
interface UndrainedRead {
	line: number;
	callee: string;
	sinks: string[];
	text: string;
	/** Lines of the undrained call sites, when the read sits in a local helper. */
	undrainedCallers: number[];
}

const READ_CALLEES = new Set([
	"statSync",
	"lstatSync",
	"readFileSync",
	"readFile",
	"createReadStream",
]);
const SCOPE_CALLEES = new Set([
	"it",
	"test",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);
const FUNCTION_KINDS = [
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
];
const CALLER_DEPTH = 3;

function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression") {
		const object = fn.field("object");
		// `it.each(...)`, `it.skipIf(...)`: the scope callee is the object.
		const objectName = object?.kind() === "identifier" ? object.text() : "";
		if (SCOPE_CALLEES.has(objectName)) return objectName;
		return fn.field("property")?.text();
	}
	if (fn?.kind() === "call_expression") return calleeName(fn);
	return undefined;
}

function isFunction(node: SgNode): boolean {
	return FUNCTION_KINDS.includes(String(node.kind()));
}

/**
 * The nearest enclosing function that owns a drain-ordering scope: a
 * declaration, a method, or a test/hook callback. A callback passed to any
 * other call (`.map`, `waitFor`, `withHome`) runs inside its caller's
 * ordering, so it is transparent.
 */
function scopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			const parent = current.parent();
			const call = parent?.kind() === "arguments" ? parent.parent() : null;
			const transparent =
				call?.kind() === "call_expression" &&
				!SCOPE_CALLEES.has(calleeName(call) ?? "");
			if (!transparent) return current;
		}
		current = current.parent();
	}
	return undefined;
}

/** The nearest enclosing function of any kind: a binding's lexical scope. */
function lexicalScopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current && !isFunction(current)) current = current.parent();
	return current ?? undefined;
}

/** The name a function is called by, when it is a local helper. */
function declaredName(fn: SgNode): string | undefined {
	if (fn.kind() !== "arrow_function" && fn.kind() !== "function_expression") {
		return fn.field("name")?.text();
	}
	const parent = fn.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

function drainPattern(names: readonly string[]): RegExp {
	const awaited = names.filter((name) => !name.endsWith("Sync"));
	const sync = names.filter((name) => name.endsWith("Sync"));
	const parts: string[] = [];
	if (awaited.length > 0) {
		parts.push(
			`\\bawait\\s+(?:[\\w$]+\\s*\\??\\.\\s*)*(?:${awaited.map(escapeRegExp).join("|")})\\s*\\(`,
		);
	}
	if (sync.length > 0) {
		parts.push(`\\b(?:${sync.map(escapeRegExp).join("|")})\\s*\\(`);
	}
	return new RegExp(parts.join("|"), "g");
}

/** `text` holds a drain from `names` with no other `await` after the last one. */
function endsDrained(text: string, names: readonly string[]): boolean {
	const last = [...text.matchAll(drainPattern(names))].at(-1);
	if (!last) return false;
	return !/\bawait\b/.test(text.slice((last.index ?? 0) + last[0].length));
}

const nameNeedle = (name: string, member: boolean): RegExp =>
	new RegExp(`${member ? "\\b" : "(?<![\\w$.])"}${escapeRegExp(name)}\\b`);

interface Binding {
	name: string;
	start: number;
	end: number;
	owners: ReadonlySet<string>;
}

function scanUndrainedSinkReads(
	source: string,
	sinks: readonly SinkModule[],
): UndrainedRead[] {
	const blanked = stripSource(source);
	const kept = stripSource(source, { strings: "keep" });
	const symbolOwner = new Map<string, string>();
	const basenameOwner = new Map<string, string>();
	for (const sink of sinks) {
		for (const symbol of sink.pathSymbols) symbolOwner.set(symbol, sink.module);
		for (const base of sink.basenames) basenameOwner.set(base, sink.module);
	}
	const literalNeedle = (base: string): RegExp =>
		new RegExp(`["'\`]${escapeRegExp(base)}["'\`]`);
	// Cheap admission on code text: no sink named, nothing to parse.
	if (
		![...symbolOwner.keys()].some((s) => nameNeedle(s, true).test(blanked)) &&
		![...basenameOwner.keys()].some((b) => literalNeedle(b).test(kept))
	) {
		return [];
	}

	const root = parse(Lang.TypeScript, source).root();
	const sinkAliases: Binding[] = [];
	const rootAliases: Binding[] = [];
	const visible = (
		bindings: Binding[],
		start: number,
		end: number,
	): Binding[] =>
		bindings.filter(
			(b) =>
				b.start <= start &&
				end <= b.end &&
				nameNeedle(b.name, false).test(blanked.slice(start, end)),
		);
	const namesRoot = (start: number, end: number): boolean =>
		LOG_ROOT_SYMBOLS.some((s) =>
			nameNeedle(s, true).test(blanked.slice(start, end)),
		) || visible(rootAliases, start, end).length > 0;
	const sinksIn = (start: number, end: number): Set<string> => {
		const owners = new Set<string>();
		const code = blanked.slice(start, end);
		for (const [symbol, owner] of symbolOwner) {
			if (nameNeedle(symbol, true).test(code)) owners.add(owner);
		}
		for (const alias of visible(sinkAliases, start, end)) {
			for (const owner of alias.owners) owners.add(owner);
		}
		const literal = kept.slice(start, end);
		for (const [base, owner] of basenameOwner) {
			if (literalNeedle(base).test(literal) && namesRoot(start, end)) {
				owners.add(owner);
			}
		}
		return owners;
	};
	const readsInside = (node: SgNode): boolean =>
		node
			.findAll({ rule: { kind: "call_expression" } })
			.some((call) => READ_CALLEES.has(calleeName(call) ?? ""));
	const bind = (
		into: Binding[],
		name: string,
		at: SgNode,
		owners: ReadonlySet<string>,
	): void => {
		const scope = lexicalScopeOf(at);
		const start = scope?.range().start.index ?? 0;
		const end = scope?.range().end.index ?? source.length;
		if (!into.some((b) => b.name === name && b.start === start)) {
			into.push({ name, start, end, owners });
		}
	};

	// Path aliases, lexically scoped: `const file = getLatencyLogPath()`,
	// `const dir = getGlobalPiLensLogDir()`, `const logFile = () =>
	// path.join(dir, "latency.log")`, `function logPath() { return ...; }`.
	const declarators = root.findAll({ rule: { kind: "variable_declarator" } });
	const functionDecls = root.findAll({
		rule: { kind: "function_declaration" },
	});
	for (let pass = 0; pass < 3; pass++) {
		for (const decl of declarators) {
			const name = decl.field("name");
			const value = decl.field("value");
			if (name?.kind() !== "identifier" || !value || readsInside(value))
				continue;
			const start = value.range().start.index;
			const end = value.range().end.index;
			const owners = sinksIn(start, end);
			if (owners.size > 0) bind(sinkAliases, name.text(), decl, owners);
			else if (namesRoot(start, end))
				bind(rootAliases, name.text(), decl, new Set());
		}
		for (const fn of functionDecls) {
			const name = fn.field("name")?.text();
			if (!name) continue;
			const owners = new Set<string>();
			for (const ret of fn.findAll({ rule: { kind: "return_statement" } })) {
				if (readsInside(ret)) continue;
				const range = ret.range();
				for (const owner of sinksIn(range.start.index, range.end.index)) {
					owners.add(owner);
				}
			}
			if (owners.size > 0) bind(sinkAliases, name, fn, owners);
		}
	}

	// Drains per sink: its flush exports, the global drain, and every local
	// helper whose own body ends drained (`await configResolvedRows()`): its
	// last drain of the sink has no other await after it.
	const drainNames = new Map<string, string[]>();
	for (const sink of sinks) {
		drainNames.set(sink.module, [...sink.flushSymbols, ...GLOBAL_DRAINS]);
	}
	const functions = root.findAll({
		rule: { any: FUNCTION_KINDS.map((kind) => ({ kind })) },
	});
	for (let pass = 0; pass < 3; pass++) {
		for (const fn of functions) {
			const name = declaredName(fn);
			if (!name) continue;
			const body = blanked.slice(fn.range().start.index, fn.range().end.index);
			for (const names of drainNames.values()) {
				if (!names.includes(name) && endsDrained(body, names)) names.push(name);
			}
		}
	}

	const calls = root.findAll({ rule: { kind: "call_expression" } });
	const callsTo = (name: string, inside: SgNode): SgNode[] => {
		const start = inside.range().start.index;
		const end = inside.range().end.index;
		return calls.filter((call) => {
			const fn = call.field("function");
			const at = call.range().start.index;
			return (
				fn?.kind() === "identifier" &&
				fn.text() === name &&
				!(start <= at && at < end)
			);
		});
	};

	/**
	 * Drained at `node` for `owner`: the last drain of that sink in the
	 * node's scope precedes it with no other `await` in between (any await
	 * lets the code under test enqueue more). With no drain in scope, a local
	 * helper is drained when every call site of it is.
	 */
	const undrainedAt = (
		node: SgNode,
		owner: string,
		depth: number,
	): number[] => {
		const scope = scopeOf(node);
		const scopeStart = scope?.range().start.index ?? 0;
		const before = blanked
			.slice(scopeStart, node.range().start.index)
			.replace(/\bawait\s*$/, "");
		const names = drainNames.get(owner) ?? GLOBAL_DRAINS;
		const line = node.range().start.line + 1;
		if (drainPattern(names).test(before)) {
			return endsDrained(before, names) ? [] : [line];
		}
		const helper = scope ? declaredName(scope) : undefined;
		if (!scope || !helper || depth >= CALLER_DEPTH) return [line];
		const sites = callsTo(helper, scope);
		if (sites.length === 0) return [line];
		return sites.flatMap((site) => undrainedAt(site, owner, depth + 1));
	};

	const hits: UndrainedRead[] = [];
	const lines = source.split("\n");
	for (const call of calls) {
		const callee = calleeName(call);
		if (!callee || !READ_CALLEES.has(callee)) continue;
		const first = call.field("arguments")?.namedChildren()[0];
		if (!first) continue;
		const owners = sinksIn(first.range().start.index, first.range().end.index);
		const undrained: string[] = [];
		const callers = new Set<number>();
		const line = call.range().start.line + 1;
		for (const owner of owners) {
			const at = undrainedAt(call, owner, 0);
			if (at.length === 0) continue;
			undrained.push(owner);
			for (const site of at) if (site !== line) callers.add(site);
		}
		if (undrained.length === 0) continue;
		hits.push({
			line,
			callee,
			sinks: undrained.sort(),
			text: lines[line - 1]?.trim() ?? "",
			undrainedCallers: [...callers].sort((a, b) => a - b),
		});
	}
	return hits;
}

/** Fixture sinks: the shape of the two real modules #4381 involves. */
const FIXTURE_SINKS: SinkModule[] = [
	{
		module: "clients/sessionstart-logger.ts",
		pathSymbols: ["SESSIONSTART_LOG_FILE"],
		flushSymbols: ["flushSessionStartLog", "flushSessionStartLogSync"],
		basenames: ["sessionstart.log"],
	},
	{
		module: "clients/latency-logger.ts",
		pathSymbols: ["getLatencyLogPath"],
		flushSymbols: ["flushLatencyLog"],
		basenames: ["latency.log"],
	},
];

const scanFixture = (source: string): UndrainedRead[] =>
	scanUndrainedSinkReads(source, FIXTURE_SINKS);

describe("sink reads drain first (#4381)", () => {
	// Recurrence: #4381 (master run 38515888889), after #3682, #3721 and #3193.
	it("no test reads an in-process log sink before draining it", () => {
		const sinks = discoverSinkModules();
		// Dead-scan floors (sweep-kit, #1718): the sink discovery and the tree
		// walk each have to find something before an empty result means clean.
		assertNonEmptyScan("ndjson sink modules", sinks.length, 10);
		const files = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
			exclude: (rel) => rel.startsWith("fixtures/"),
		});
		assertNonEmptyScan("tests/ source files", files.length, 1000);
		const violations: string[] = [];
		let sinkFiles = 0;
		for (const absolute of files) {
			const rel = relativePosix(REPO_ROOT, absolute);
			if (rel === SELF) continue;
			const source = readWalkedFile(absolute);
			if (source === undefined) continue;
			if (
				sinks.some((sink) => sink.pathSymbols.some((s) => source.includes(s)))
			)
				sinkFiles += 1;
			for (const hit of scanUndrainedSinkReads(source, sinks)) {
				const callers = hit.undrainedCallers.length
					? ` (undrained call sites: ${hit.undrainedCallers.map((line) => `:${line}`).join(", ")})`
					: "";
				violations.push(
					`${rel}:${hit.line} ${hit.callee} of ${hit.sinks.join(", ")}${callers}: ${hit.text}`,
				);
			}
		}
		assertNonEmptyScan("test files naming a sink path symbol", sinkFiles, 20);
		expect(
			violations,
			"a test reads a log sink while its own writes may still be queued (#4381). " +
				"Await the sink's flush (flushSessionStartLog, flushLatencyLog, ..., or " +
				"flushAllNdjsonWriters) in the same scope right before the read, with no " +
				"other await in between, or inside the helper that reads.",
		).toEqual([]);
	}, 120_000);

	it("every sink module roots its path in LOG_ROOT_SYMBOLS (drift pin)", () => {
		// A sink that moves to another root would make the basename evidence
		// above silently stop matching its in-process reads.
		const unrooted = discoverSinkModules()
			.filter(
				({ source }) =>
					!LOG_ROOT_SYMBOLS.some((symbol) =>
						nameNeedle(symbol, true).test(stripSource(source)),
					),
			)
			.map(({ module }) => module);
		expect(unrooted).toEqual([]);
	});

	describe("sink discovery", () => {
		it("reads path symbols, drains and basenames from a sink module", () => {
			const sink = sinkModuleFromSource(
				"clients/x-logger.ts",
				[
					'const X_LOG_FILE = path.join(getGlobalPiLensLogDir(), "x.log");',
					"const writer = createNdjsonLogger({ filePath: X_LOG_FILE });",
					"export function getXLogPath(): string { return X_LOG_FILE; }",
					"export function flushXLog(): Promise<void> { return writer.flush(); }",
					"export function logX(): void {}",
				].join("\n"),
			);
			expect(sink).toEqual({
				module: "clients/x-logger.ts",
				pathSymbols: ["getXLogPath"],
				flushSymbols: ["flushXLog"],
				basenames: ["x.log"],
			});
		});

		it("a module naming the factory only in a comment or string is no sink", () => {
			expect(
				sinkModuleFromSource(
					"clients/y.ts",
					'// createNdjsonLogger({ filePath })\nconst s = "createNdjsonLogger(";',
				),
			).toBeUndefined();
		});
	});

	describe("detector", () => {
		const offsetHelper = [
			"function sessionStartOffset(): number {",
			"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
			"}",
		].join("\n");

		it("flags the #4381 shape: an offset helper with no drain, called after a write", () => {
			const hits = scanFixture(
				[
					offsetHelper,
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tawait flushLatencyLog();",
					"\tconst offset = sessionStartOffset();",
					"});",
				].join("\n"),
			);
			expect(hits).toEqual([
				{
					line: 2,
					callee: "statSync",
					sinks: ["clients/sessionstart-logger.ts"],
					text: "return fs.statSync(SESSIONSTART_LOG_FILE).size;",
					undrainedCallers: [7],
				},
			]);
		});

		it("accepts the fixed helper: it drains its own sink before the offset", () => {
			expect(
				scanFixture(
					[
						"async function sessionStartOffset(): Promise<number> {",
						"\tawait flushSessionStartLog();",
						"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"}",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a drain named only in a comment or a string does not count", () => {
			for (const launder of [
				"\t// await flushSessionStartLog();",
				'\tconst note = "await flushSessionStartLog();";',
				"\tconst note = `await flushSessionStartLog();`;",
			]) {
				const hits = scanFixture(
					[
						'it("x", async () => {',
						launder,
						"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"});",
					].join("\n"),
				);
				expect(
					hits.map((hit) => hit.line),
					launder,
				).toEqual([3]);
			}
		});

		it("a drain of a different sink does not count", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.sinks)).toEqual([
				["clients/sessionstart-logger.ts"],
			]);
		});

		it("an await between the drain and the read voids the drain", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tawait new Promise((resolve) => setImmediate(resolve));",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([4]);
		});

		it("accepts a sync Sync-drain, the global drain, and a local draining helper", () => {
			expect(
				scanFixture(
					[
						"async function rows(): Promise<string> {",
						"\tawait flushLatencyLog();",
						'\treturn fs.readFileSync(getLatencyLogPath(), "utf8");',
						"}",
						'it("x", async () => {',
						"\tflushSessionStartLogSync();",
						"\tconst a = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait flushAllNdjsonWriters();",
						"\tconst b = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait rows();",
						'\tconst c = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a helper that awaits more work after its drain is no drain", () => {
			const hits = scanFixture(
				[
					"async function settle(): Promise<void> {",
					"\tawait flushLatencyLog();",
					"\tawait runTurn();",
					"}",
					'it("x", async () => {',
					"\tawait settle();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([7]);
		});

		it("an inline callback reads inside its caller's drain order; aliases resolve", () => {
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tconst file = getLatencyLogPath();",
						"\tawait flushLatencyLog();",
						"\tconst sizes = [file].map((f) => fs.statSync(file).size);",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a sync reader helper is drained only when every call site drains", () => {
			const reader = [
				"function rowsFor(): string {",
				"\tconst file = getLatencyLogPath();",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			const drained = [
				'it("a", async () => {',
				"\tawait flushLatencyLog();",
				'\texpect(rowsFor()).toBe("");',
				"});",
			];
			expect(scanFixture([...reader, ...drained].join("\n"))).toEqual([]);
			const hits = scanFixture(
				[
					...reader,
					...drained,
					'it("b", async () => {',
					'\texpect(rowsFor()).toBe("");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[3, [10]],
			]);
		});

		it("a basename literal names an in-process sink only under an in-process root", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					'\tconst child = fs.readFileSync(path.join(childHome, "latency.log"), "utf8");',
					'\tconst notes = fs.statSync(path.join(dir, "notes.txt")).size;',
					"\tconst root = getGlobalPiLensLogDir();",
					'\tconst own = fs.readFileSync(path.join(root, "latency.log"), "utf8");',
					'\tconst env = fs.readFileSync(path.join(process.env.PI_LENS_HOME ?? "", "latency.log"), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([5, 6]);
		});
	});
});
