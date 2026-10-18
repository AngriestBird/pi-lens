/**
 * #4589: a test that starts a real listening server must close it, and await
 * the close, before the case or the file ends — a ratchet.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * binds a port or a socket path and a later case in the same worker finds it
 * held. The named recurrence for this rule is #4581 (a case that started a
 * real background resource and did not await its own teardown, so it outlived
 * the test). Rule A (`test-env-restore-sweep.test.ts`) covers unrestored env
 * writes; this rule covers the listener. The detector lives in
 * `tests/support/test-server-teardown-gate.ts`; its docstring states the
 * accepted start forms, the accepted teardown placements (a teardown hook, a
 * `finally`, the start's own function, or a local helper every call site
 * settles) and the declared gaps.
 *
 * The state table the sweep decides from, one row per form:
 *
 * | start form | teardown form | verdict |
 * |---|---|---|
 * | `const s = createServer(...)`, pushed to a module array | `afterEach` iterates it, awaiting `Promise.all(... map(s => new Promise(r => s.close(r))))` | closed |
 * | `const s = net.createServer(...)`, pushed to a describe's array | `afterEach` awaits `new Promise(r => s.close(r))` per element | closed |
 * | `const s = http.createServer(...)`, assigned to `server` | `afterEach` awaits `new Promise(r => server.close(r))` | closed |
 * | `const s = net.createServer(...)`, `.listen` and close in one helper | `await new Promise(r => s.close(r))` in the same function | closed |
 * | `const s = net.createServer(...)` | `afterEach(() => new Promise(r => s.close(r)))` (the hook returns it) | closed |
 * | `const s = net.createServer(...)` | `afterEach(closeServer)`, a same-file function that awaits the close | closed |
 * | `const s = net.createServer(...)` | `const closed = new Promise(...); await closed;` | closed |
 * | `let s; s = net.createServer(...)` at file scope | `afterEach` calls `s.close()`, unawaited | unawaited (baseline) |
 * | `const s = net.createServer(...)` | `finally { s.closeAllConnections?.(); s.close(); }`, unawaited | unawaited (baseline) |
 * | a helper returns `{ close: () => new Promise(d => s.close(d)) }` | caller awaits `handle.close()` | helper (baseline) |
 * | `new WebSocketServer({ port })` | none | unresolvable — always reported |
 * | `Bun.serve({ port })` | none | unresolvable — the handle is not readable |
 * | `dgram.createSocket("udp4").bind(0)` | none | unresolvable — a start verb on a socket handle |
 *
 * Settlement is proven on the awaited VALUE, never on proximity (F1):
 * `await xs.forEach(...)` and `await xs.map(...)` await undefined and an array,
 * `Promise.race` can settle on another value, and a helper that creates the
 * promise without returning it settles nothing — all report. A `bind`/`serve`
 * on a receiver that is not a socket or server handle is
 * `Function.prototype.bind`, not a start, and that reading is declared in the
 * detector's docstring.
 *
 * A `.listen` receiver that is not a plain identifier, and a server
 * construction the binding scan cannot attribute to a start, are reported as
 * `unresolvable` rather than counted clean (AGENTS.md shape 69): the detector
 * fails closed on a start spelling it does not know.
 *
 * The baseline (`tests/support/test-server-teardown-baseline.ts`) admits the
 * starts already unproven on master, so this lands as a ratchet instead of a
 * mass edit. Every admitted row carries a reason in
 * `tests/support/test-server-teardown-admissions.ts`, re-checked here against
 * the file's own close evidence: a new row cannot be admitted by appending one
 * line (AGENTS.md shape 38).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import { TEST_SERVER_TEARDOWN_ADMISSIONS } from "../support/test-server-teardown-admissions.js";
import { TEST_SERVER_TEARDOWN_BASELINE } from "../support/test-server-teardown-baseline.js";
import {
	escapeRowKey,
	findUnclosedServerStarts,
	type ServerTeardownFinding,
	serverTeardownKey,
	serverTeardownMechanisms,
} from "../support/test-server-teardown-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const BASELINE_PATH = path.join(
	REPO_ROOT,
	"tests/support/test-server-teardown-baseline.ts",
);
const BASELINE_HEADER =
	"#4589 baseline: the started servers already unproven on master, admitted so the sweep is a ratchet, not a mass edit.";
/** The admission guard's row spelling; a regenerated row must pass it. */
const ROW_RE = /^tests\/[\w./-]+\.ts:[^\s]+$/;
const BASELINE: ReadonlySet<string> = new Set(TEST_SERVER_TEARDOWN_BASELINE);

function detectAcrossFiles(files: string[]): ServerTeardownFinding[] {
	const findings: ServerTeardownFinding[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		// Repo-relative, so a baseline row survives a lane's absolute path.
		findings.push(
			...findUnclosedServerStarts(relativePosix(REPO_ROOT, file), source),
		);
	}
	return findings;
}

let sweepPromise: ServerTeardownFinding[] | undefined;

function sweepOnce(): ServerTeardownFinding[] {
	if (sweepPromise) return sweepPromise;
	const files = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] });
	// Floor 1,500 against the ~1,600 `tests/**/*.ts` at authoring time: low
	// enough that ordinary churn never trips it, high enough that a silently
	// dropped directory does (shape 10).
	assertNonEmptyScan("#4589 server-teardown sweep", files.length, 1500);
	sweepPromise = detectAcrossFiles(files);
	return sweepPromise;
}

/** Baseline rows the live tree no longer reports, so the list only shrinks. */
function staleBaselineRows(
	findings: readonly ServerTeardownFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const live = new Set(findings.map(serverTeardownKey));
	return [...baseline].filter((entry) => !live.has(entry)).sort();
}

/**
 * Keys the live tree reports that the baseline does not admit. One row per
 * distinct `file:receiver`: a second start of an admitted binding in the same
 * file is the same decision, not a new offender.
 */
function unadmittedOffenders(
	findings: readonly ServerTeardownFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const reported = new Map<string, ServerTeardownFinding>();
	for (const finding of findings) {
		const entry = serverTeardownKey(finding);
		if (baseline.has(entry) || reported.has(entry)) continue;
		reported.set(entry, finding);
	}
	return [...reported.values()]
		.map(
			(finding) =>
				`${serverTeardownKey(finding)} (${finding.verdict} at line ${finding.line}): ${finding.reason}`,
		)
		.sort();
}

describe("#4589 server-teardown detector — the shapes that must red and green", () => {
	const detect = (source: string) =>
		findUnclosedServerStarts("tests/config/case.test.ts", source);

	it("reds on a listener nothing closes (#4581: a case starts a real resource and never tears it down)", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
			]),
		).toEqual([["server", "unclosed"]]);
	});

	it("reds on a close that is not awaited (#4581: a teardown that starts and is never awaited)", () => {
		// `net.Server.close()` returns the server, so neither a bare call nor
		// `await server.close()` settles: only the callback form, wrapped in a
		// promise, has a completion to await.
		for (const close of [
			"\tserver.close();",
			"\tawait server.close();",
			"\tserver.close(() => resolveClose());",
		]) {
			const findings = detect(
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(() => {",
					close,
					"});",
				].join("\n"),
			);
			expect(
				findings.map((finding) => [finding.server, finding.verdict]),
				close,
			).toEqual([["server", "unawaited"]]);
			expect(findings[0]?.mechanism, close).toBe("teardown");
		}
	});

	it("greens on an awaited close in a teardown hook", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
				"afterEach(async () => {",
				"\tawait new Promise((resolve) => server.close(() => resolve()));",
				"});",
			]),
		).toEqual([]);
	});

	it("greens on a close in the start's own `finally`", () => {
		expect(
			scanListen([
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\ttry {",
				"\t\tawait run();",
				"\t} finally {",
				"\t\tawait new Promise((resolve) => server.close(() => resolve()));",
				"\t}",
				"});",
			]),
		).toEqual([]);
	});

	it("serves the sonar shape: a module array closed in afterEach through Promise.all", () => {
		expect(
			scanListen([
				"const servers = [];",
				"afterEach(async () => {",
				"\tawait Promise.all(",
				"\t\tservers.splice(0).map(",
				"\t\t\t(server) =>",
				"\t\t\t\tnew Promise((resolveClose) =>",
				"\t\t\t\t\tserver.close(() => resolveClose()),",
				"\t\t\t\t),",
				"\t\t),",
				"\t);",
				"});",
				"async function start() {",
				"\tconst server = net.createServer(() => {});",
				"\tservers.push(server);",
				"\tawait new Promise((resolveListen) => server.listen(0, resolveListen));",
				"}",
			]),
		).toEqual([]);
	});

	it("serves the ipc-frame-bounds shape: a describe array closed in a for-of afterEach", () => {
		expect(
			scanListen([
				"describe('x', () => {",
				"\tconst sockets = [];",
				"\tafterEach(async () => {",
				"\t\tfor (const server of sockets.splice(0)) {",
				"\t\t\tawait new Promise((resolve) => server.close(() => resolve()));",
				"\t\t}",
				"\t});",
				"\tit('a', async () => {",
				"\t\tconst server = net.createServer(() => {});",
				"\t\tsockets.push(server);",
				"\t\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\t});",
				"});",
			]),
		).toEqual([]);
	});

	it("greens on Promise.all over an array of close promises", () => {
		// The awaited value is the combinator's promise, and the array holds the
		// close promises themselves (not a callback's return values).
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(0, resolve));",
				"afterEach(async () => {",
				"\tawait Promise.all([",
				"\t\tnew Promise((resolve) => server.close(() => resolve())),",
				"\t]);",
				"});",
			]),
		).toEqual([]);
	});

	it("follows a `let server; server = local` alias, and a close in the start's function", () => {
		expect(
			scanListen([
				"let server;",
				"async function serve() {",
				"\tconst local = http.createServer(() => {});",
				"\tawait new Promise((resolve) => local.listen(0, resolve));",
				"\tserver = local;",
				"}",
				"afterEach(async () => {",
				"\tif (server) await new Promise((r) => server.close(() => r()));",
				"});",
			]),
		).toEqual([]);
	});

	it("reports a returned close closure as `helper`, and a settled close elsewhere as `misplaced`", () => {
		// A close the detector cannot follow is reported, never credited: the
		// handle crosses a return value (the analyze-cli stub shape).
		expect(
			scanListen([
				"function startStub() {",
				"\tconst server = net.createServer(() => {});",
				"\treturn new Promise((resolve) => server.listen(endpoint, () =>",
				"\t\tresolve({ close: () => new Promise((done) => { server.close(() => done()); }) }),",
				"\t));",
				"}",
			]),
		).toEqual([["server", "helper"]]);
		// A settled close with no accepted placement: the listener is closed and
		// awaited, but at module scope, where no teardown can rely on it running.
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"it('a', async () => {",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"});",
				"await new Promise((resolve) => server.close(() => resolve()));",
			]),
		).toEqual([["server", "misplaced"]]);
	});

	it("follows a local helper whose every call site awaits it", () => {
		expect(
			scanListen([
				"function stop() {",
				"\treturn new Promise((resolve) => server.close(() => resolve()));",
				"}",
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait stop();",
				"});",
			]),
		).toEqual([]);
		// One unawaited call site voids the helper credit.
		expect(
			scanListen([
				"function stop() {",
				"\treturn new Promise((resolve) => server.close(() => resolve()));",
				"}",
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait stop();",
				"});",
				"it('b', () => {",
				"\tstop();",
				"});",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("settles only when the awaited value is the close promise (F1, escapes)", () => {
		// A `.listen` start pushed to a module array, closed inside `afterEach`.
		const arrayTeardown = (body: string[]): string[] => [
			"const servers = [];",
			"afterEach(async () => {",
			...body,
			"});",
			"async function start() {",
			"\tconst server = net.createServer(() => {});",
			"\tservers.push(server);",
			"\tawait new Promise((resolve) => server.listen(0, resolve));",
			"}",
		];
		const escapes: Array<[string, string[]]> = [
			[
				"forEach discards the callback's value",
				[
					"\tawait servers.forEach((server) =>",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t);",
				],
			],
			[
				"map without Promise.all awaits an array",
				[
					"\tawait servers.map((server) =>",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t);",
				],
			],
			[
				"Promise.race can settle on another value",
				[
					"\tawait Promise.race([",
					"\t\tnew Promise((resolve) => server.close(() => resolve())),",
					"\t\ttimeout,",
					"\t]);",
				],
			],
			[
				"awaiting an array of promises settles none of them",
				["\tawait [new Promise((resolve) => server.close(() => resolve()))];"],
			],
			[
				"a stored promise whose reference nothing settles",
				[
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
					"\tvoid closed;",
				],
			],
			[
				"a stored promise nothing awaits at all",
				[
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
				],
			],
		];
		for (const [label, body] of escapes) {
			const findings = detect(arrayTeardown(body).join("\n"));
			expect(
				findings.map((finding) => [
					finding.server,
					finding.verdict,
					finding.mechanism,
				]),
				label,
			).toEqual([["server", "unawaited", "teardown"]]);
		}
	});

	it("reports a helper that creates the close promise and drops it (F1)", () => {
		expect(
			scanListen([
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(endpoint, resolve));",
				"function stop() {",
				"\tnew Promise((resolve) => server.close(() => resolve()));",
				"}",
				"await stop();",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("reports a settlement form nobody listed (a derived promise)", () => {
		// The close promise is consumed through `.then(...)`, whose own promise
		// nobody awaits. The detector does not reason about a derived promise,
		// so the row reports instead of passing (shape 69, fail closed).
		expect(
			scanListen([
				"it('a', async () => {",
				"\tconst server = net.createServer(() => {});",
				"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
				"\tawait new Promise((resolve) => server.close(() => resolve())).then(",
				"\t\t() => undefined,",
				"\t);",
				"});",
			]),
		).toEqual([["server", "unawaited"]]);
	});

	it("greens on the teardown forms vitest awaits (F1, false positives)", () => {
		const forms: Array<[string, string[]]> = [
			[
				"the hook returns the promise",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(() =>",
					"\tnew Promise((resolve) => server.close(() => resolve())),",
					");",
				],
			],
			[
				"the hook is handed the function by reference",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"async function closeServer() {",
					"\tawait new Promise((resolve) => server.close(() => resolve()));",
					"}",
					"afterEach(closeServer);",
				],
			],
			[
				"the hook is handed a function that returns the promise",
				[
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"function closeServer() {",
					"\treturn new Promise((resolve) => server.close(() => resolve()));",
					"}",
					"afterEach(closeServer);",
				],
			],
			[
				"the promise is stored and awaited later",
				[
					"it('a', async () => {",
					"\tconst server = net.createServer(() => {});",
					"\tawait new Promise((resolve) => server.listen(endpoint, resolve));",
					"\tconst closed = new Promise((resolve) =>",
					"\t\tserver.close(() => resolve()),",
					"\t);",
					"\tawait closed;",
					"});",
				],
			],
		];
		for (const [label, form] of forms) {
			expect(detect(form.join("\n")), label).toEqual([]);
		}
	});

	it("reports a start verb on a handle the scan cannot follow (F4)", () => {
		// `Bun.serve` binds a port with no handle the detector can read.
		expect(
			scanListen([
				"const handle = Bun.serve({ port: 0, fetch: () => new Response() });",
			]),
		).toEqual([["Bun", "unresolvable"]]);
		// A socket `bind` is a start: inline, and through a readable variable.
		expect(scanListen(['dgram.createSocket("udp4").bind(0);'])).toEqual([
			['dgram.createSocket("udp4")', "unresolvable"],
		]);
		expect(
			scanListen([
				'const socket = dgram.createSocket("udp4");',
				"socket.bind(0);",
			]),
		).toEqual([["socket", "unclosed"]]);
		// `Function.prototype.bind` on a value that is not a handle is not a
		// start (the tree has 59 of them).
		expect(
			scanListen(["const fn = () => {};", "const bound = fn.bind(null);"]),
		).toEqual([]);
	});

	it("reports a non-identifier receiver and an unclassified construction (fail closed)", () => {
		expect(
			scanListen([
				"await new Promise((resolve) => net.createServer(() => {}).listen(0, resolve));",
			]).map(([server]) => server),
		).toEqual(["net.createServer(()=>{})"]);
		// `new WebSocketServer({ port })` binds without a `.listen` call: the
		// construction screen reports it instead of counting the file clean.
		expect(
			scanListen([
				"import { WebSocketServer } from 'ws';",
				"const wss = new WebSocketServer({ port: 0 });",
				"it('a', () => { expect(wss.address()).toBeDefined(); });",
			]),
		).toEqual([["WebSocketServer", "unresolvable"]]);
	});

	it("a close named only in a comment or a string does not count", () => {
		for (const launder of [
			"\t// await new Promise((r) => server.close(() => r()));",
			'\tconst note = "server.close(() => resolve())";',
		]) {
			expect(
				scanListen([
					"const server = net.createServer(() => {});",
					"await new Promise((resolve) => server.listen(endpoint, resolve));",
					"afterEach(async () => {",
					launder,
					"});",
				]).map(([receiver, verdict]) => [receiver, verdict]),
			).toEqual([["server", "unclosed"]]);
		}
	});

	/** Run the detector over a listener-only fixture, with the file header. */
	function scanListen(lines: string[]): Array<[string, string]> {
		return detect(lines.join("\n")).map((finding) => [
			finding.server,
			finding.verdict,
		]);
	}

	it("a computed receiver name is escaped, so a regenerated row passes the guard", () => {
		const findings = detect(
			[
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server['listen']?.(0, resolve));",
			].join("\n"),
		);
		// `server['listen']` is not a `.listen` member call this detector reads:
		// the construction is reported rather than the start (fail closed).
		expect(findings.map((finding) => serverTeardownKey(finding))).toEqual([
			"tests/config/case.test.ts:createServer",
		]);
		expect(escapeRowKey("a b%c")).toBe("a%20b%25c");
		for (const finding of findings)
			expect(ROW_RE.test(serverTeardownKey(finding))).toBe(true);
	});

	it("reds when a baseline row vanishes from the tree", () => {
		const live = detect(
			[
				"const server = net.createServer(() => {});",
				"await new Promise((resolve) => server.listen(0, resolve));",
			].join("\n"),
		);
		expect(
			staleBaselineRows(live, new Set(["tests/config/case.test.ts:server"])),
		).toEqual([]);
		expect(
			staleBaselineRows(
				live,
				new Set([
					"tests/config/case.test.ts:server",
					"tests/config/gone.test.ts:server",
				]),
			),
		).toEqual(["tests/config/gone.test.ts:server"]);
	});
});

describe("#4589 server-teardown ratchet", () => {
	beforeAll(() => sweepOnce(), 120_000);

	it("reports every unproven start and reds on a new one", () => {
		const findings = sweepOnce();
		const problems = unadmittedOffenders(findings, BASELINE);
		process.stderr.write(
			`server-teardown-sweep: ${findings.length} live start(s), ${BASELINE.size} baselined, ${problems.length} new\n`,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	}, 60_000);

	it("baseline entries remain live", () => {
		// The shrink-only direction: closing a server anywhere makes its row
		// stale, and a stale row reds until it is deleted.
		expect(staleBaselineRows(sweepOnce(), BASELINE)).toEqual([]);
	}, 60_000);

	it("finds the tree's start population (the sweep is not dead)", () => {
		// A floor on the START population, not on the findings: the tree has
		// ~20 `.listen` calls, and a walk that stops reaching them must red
		// rather than report a clean ratchet (shape 10).
		const files = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] });
		const listeners = files.filter((file) => {
			const source = readWalkedFile(file);
			return source !== undefined && /\.listen\s*\(/.test(source);
		});
		assertNonEmptyScan("test files starting a listener", listeners.length, 6);
	}, 60_000);

	it.skipIf(!process.env.TEST_SERVER_TEARDOWN_REGEN)(
		"regenerates the baseline",
		() => {
			const rows = [...new Set(sweepOnce().map(serverTeardownKey))].sort();
			fs.writeFileSync(
				BASELINE_PATH,
				[
					"/**",
					` * ${BASELINE_HEADER}`,
					" *",
					" * A row is `<file>:<receiver>`, keyed on the file and the started",
					' * binding, never on a line. It means "this start is not PROVABLY',
					' * closed and awaited here", so a row in a file that does close its',
					" * server is honest: it shrinks when the file is made readable. Why each",
					" * row is admitted, and the close evidence the detector found instead,",
					" * lives in `test-server-teardown-admissions.ts`; every row here must",
					" * have an entry there.",
					" */",
					"",
					"export const TEST_SERVER_TEARDOWN_BASELINE: readonly string[] = [",
					...rows.map((row) => `\t${JSON.stringify(row)},`),
					"];",
					"",
				].join("\n"),
			);
		},
		60_000,
	);
});

describe("#4589 server-teardown admission guard", () => {
	it("keeps the baseline a list of file:receiver rows", () => {
		const malformed = TEST_SERVER_TEARDOWN_BASELINE.filter(
			(row) => !ROW_RE.test(row),
		);
		expect(malformed).toEqual([]);
		expect(new Set(TEST_SERVER_TEARDOWN_BASELINE).size).toBe(
			TEST_SERVER_TEARDOWN_BASELINE.length,
		);
		expect(
			fs.readFileSync(BASELINE_PATH, "utf8").includes(BASELINE_HEADER),
		).toBe(true);
	});

	it("admits every row with a reason, and no reason without a row", () => {
		// Shape 38: a new leak cannot be admitted by appending one baseline
		// line. Both directions, so a deleted row takes its reason with it.
		const rows = new Set(TEST_SERVER_TEARDOWN_BASELINE);
		const admitted = new Set(Object.keys(TEST_SERVER_TEARDOWN_ADMISSIONS));
		expect([...rows].filter((row) => !admitted.has(row)).sort()).toEqual([]);
		expect([...admitted].filter((row) => !rows.has(row)).sort()).toEqual([]);
		for (const [row, admission] of Object.entries(
			TEST_SERVER_TEARDOWN_ADMISSIONS,
		))
			expect(
				admission.reason.length,
				`${row} needs a real reason`,
			).toBeGreaterThan(80);
	});

	it("re-checks every admission's mechanism against the file it names", () => {
		// The reason's mechanism is a claim about the file's source, re-derived
		// here by the detector's own classifier: a row admitted as `teardown`
		// must have a close in a teardown hook, not merely a `finally` or a
		// returned closure somewhere in the file.
		const problems: string[] = [];
		for (const [row, admission] of Object.entries(
			TEST_SERVER_TEARDOWN_ADMISSIONS,
		)) {
			const file = row.slice(0, row.indexOf(":"));
			const source = readWalkedFile(path.join(REPO_ROOT, file));
			if (source === undefined) {
				problems.push(`${row}: admission names a file the walk skips`);
				continue;
			}
			const findings = findUnclosedServerStarts(file, source).filter(
				(finding) => serverTeardownKey(finding) === row,
			);
			if (findings.length === 0) {
				problems.push(`${row}: admitted, but the detector reports no finding`);
				continue;
			}
			const mechanisms = serverTeardownMechanisms(source, findings);
			if (!mechanisms.includes(admission.mechanism))
				problems.push(
					`${row}: admitted as ${admission.mechanism}, but the file shows [${mechanisms.join(", ")}]`,
				);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("crosses the boundary: a teardown hook elsewhere cannot launder a returned close", () => {
		// The guard's own seam, driven through the production classifier: the
		// file HAS an awaiting teardown for another server, and the true
		// evidence for this one is a returned closure. Presence alone would
		// accept `teardown`, which is the wrong record this check exists to red.
		const source = [
			"const server = net.createServer(() => {});",
			"await new Promise((resolve) => server.listen(endpoint, resolve));",
			"afterEach(async () => {",
			"\tawait new Promise((resolve) => other.close(() => resolve()));",
			"});",
			"const handle = {",
			"\tclose: () => new Promise((done) => { server.close(() => done()); }),",
			"};",
		].join("\n");
		const findings = findUnclosedServerStarts(
			"tests/config/probe.test.ts",
			source,
		);
		expect(findings.map((finding) => finding.verdict)).toEqual(["helper"]);
		expect(serverTeardownMechanisms(source, findings)).toEqual(["helper"]);
	});
});
