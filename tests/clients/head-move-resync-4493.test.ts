// flake-shape: real-process-spawn — a clean-tree HEAD move exists only in a real repository that git checks out, rebases or resets; a stubbed git could not rewrite the files the language server holds.
// flake-shape: in-process-mock — a project lsp.json cannot declare an auxiliary server (its role is reserved and inert), so the catalog lookup adds the auxiliary fake for the repositories registered here; every server is still a real child process on a real stdio wire
/**
 * #4493: a clean-tree HEAD move left held documents stale on the server.
 *
 * After `git checkout B` on a clean tree (and a completed rebase or
 * cherry-pick, `git reset --hard`, or the same checkout made outside pi),
 * `git status` is empty, so opaque recovery resynced nothing and the server
 * kept the pre-move bytes of every document pi-lens had open. The next edit
 * of an unrelated line was blocked by an error `tsc` on disk does not report.
 *
 * These cases drive the REAL `handleToolCall` / `handleToolResult` seams with
 * a real RuntimeCoordinator, a real git repository and the real LSPService,
 * client and stdio wire. The servers are the shared fake LSP child process,
 * project-configured, with `FAKE_LSP_TRACE_TEXT` so its trace names the bytes
 * each didOpen/didChange carried: the wire is the witness, not pi-lens's own
 * bookkeeping. Only the host's command execution is stood in for: the test
 * runs the git command between the two hooks, as pi's bash tool would.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import {
	headRecordKey,
	observeGitHead,
	recoverOpaqueChangesViaGit,
	resetOpaqueMutationState,
} from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	handleToolResult,
	resyncHeadMove,
} from "../../clients/runtime-tool-result.js";
import { execFileSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

/**
 * #4493 r2: the auxiliary scanner a repository's `.ts` files also go to (the
 * ast-grep slot of the default stack). A project `lsp.json` cannot declare an
 * auxiliary (its `role` is reserved and inert, clients/lsp/config.ts), so the
 * catalog lookup adds it for the repositories registered here, the pattern the
 * #1714 real-stream suites use; every other lookup is the real one.
 */
const auxiliaries = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../clients/lsp/config.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/config.js")>();
	const { sep } = await import("node:path");
	return {
		...actual,
		getServersForFileWithConfig: (filePath: string) => {
			const servers = actual.getServersForFileWithConfig(filePath);
			for (const [dir, aux] of auxiliaries)
				if (filePath.startsWith(`${dir}${sep}`))
					return [...servers, aux as (typeof servers)[number]];
			return servers;
		},
	};
});

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4493-head-move-";
const env = setupTestEnvironment(PREFIX);

const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

interface Repo {
	dir: string;
	trace: string;
	git: (...args: string[]) => string;
	file: (name: string) => string;
}

let repoCount = 0;

/** Real git in `cwd`, with a fixed identity; its trimmed stdout. */
function runGit(cwd: string, args: string[]): string {
	return String(
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.local",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.local",
			},
		}),
	).trim();
}

/**
 * A repository on branch `A` whose branch `B` rewrites `changed`. Both
 * servers are the fake, one for `.ts` and one for `.py` (the non-TypeScript
 * row); the built-in servers that would claim those files are disabled.
 */
async function makeRepo(
	base: Record<string, string>,
	changed: Record<string, string>,
	initArgs: string[] = [],
): Promise<Repo> {
	const dir = path.join(env.tmpDir, `repo-${++repoCount}`);
	const trace = path.join(env.tmpDir, `repo-${repoCount}.trace`);
	fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
	const shim = path.join(env.tmpDir, `repo-${repoCount}-server.mjs`);
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_TRACE_TEXT = "1";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	const server = (extensions: string[]) => ({
		name: "fake",
		extensions,
		command: process.execPath,
		args: [shim],
		rootMarkers: ["package.json"],
	});
	const files: Record<string, string> = {
		"package.json": "{}\n",
		".gitignore": ".pi-lens/\n",
		// Same files committed in the same second give the same commit ids;
		// this makes every repository's ids, and so its rows, its own.
		"repo-id.txt": `${repoCount}\n`,
		...base,
	};
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
	fs.writeFileSync(
		path.join(dir, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: { "fake-ts": server([".ts"]), "fake-py": server([".py"]) },
			disabledServers: [
				"typescript",
				"deno",
				"python",
				"python-jedi",
				"opengrep",
				"ast-grep",
				"typos",
			],
		}),
	);
	const git = (...args: string[]) => runGit(dir, args);
	git("init", "-q", "-b", "A", ...initArgs);
	git("add", "-A");
	git("commit", "-qm", "base");
	git("branch", "B");
	git("checkout", "-q", "B");
	for (const [name, content] of Object.entries(changed))
		fs.writeFileSync(path.join(dir, name), content);
	git("commit", "-qam", "B");
	git("checkout", "-q", "A");
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	return { dir, trace, git, file: (name) => path.join(dir, name) };
}

async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

/** Open `files` on their server, as the post-write sync does. */
async function hold(repo: Repo, names: string[]): Promise<void> {
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
	}
}

/**
 * Give `repo`'s `.ts` files an auxiliary scanner that spends `changeCostMs` of
 * synchronous work on each didChange, and open `names` on both servers.
 */
async function holdWithAuxiliary(
	repo: Repo,
	names: string[],
	changeCostMs: number,
): Promise<void> {
	const { spawnFakeLspServer } = await import("../support/fake-lsp-server.js");
	auxiliaries.set(repo.dir, {
		id: `fake-aux-${path.basename(repo.dir)}`,
		name: "fake-aux",
		role: "auxiliary",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => repo.dir,
		spawn: async () => ({
			process: await spawnFakeLspServer({
				cwd: repo.dir,
				env: {
					...process.env,
					FAKE_LSP_CHANGE_COST_MS: String(changeCostMs),
				},
			}),
			source: "test" as const,
		}),
	});
	const service = await lspService();
	for (const name of names) {
		const file = repo.file(name);
		await service.touchFile(file, fs.readFileSync(file, "utf8"), {
			diagnostics: "none",
			clientScope: "all",
			source: "lsp_sync",
		});
	}
}

function traceLines(repo: Repo): string[] {
	return fs.existsSync(repo.trace)
		? fs.readFileSync(repo.trace, "utf8").split("\n").filter(Boolean)
		: [];
}

/**
 * The server's trace up to a request sent now. The fake reads stdin in
 * order, and the client writes one ordered stream, so a didChange written
 * before this call is traced before the request is answered. A plain read of
 * the trace races the server process instead.
 */
async function wire(repo: Repo, onServerOf: string): Promise<string[]> {
	await (await lspService()).documentSymbol(repo.file(onServerOf));
	return traceLines(repo);
}

/** The bytes the server received after `mark` trace lines, as `text` lines. */
async function textSince(
	repo: Repo,
	mark: number,
	onServerOf: string,
): Promise<string[]> {
	return (await wire(repo, onServerOf))
		.slice(mark)
		.filter((line) => line.startsWith("text "));
}

const textLine = (repo: Repo, name: string) =>
	`text ${pathToFileURL(repo.file(name)).href} ${sha(fs.readFileSync(repo.file(name), "utf8"))}`;

/**
 * Whether the client already sent `name`'s disk bytes, read synchronously:
 * called right after a hook returns, with the service fetched beforehand, it
 * says the didChange went out BEFORE the return (no later microtask or I/O
 * can complete in between). The wire check then shows the server got them.
 */
function sentDiskBytes(
	service: Awaited<ReturnType<typeof lspService>>,
	repo: Repo,
	name: string,
): boolean {
	const file = repo.file(name);
	const want = hashDiagnosticContent(fs.readFileSync(file, "utf8"));
	return service.getTrackedContent(file, repo.dir)?.hash === want;
}

/**
 * One pi session's hooks. `shared` passes another session's coordinator: in
 * index.ts one module-level RuntimeCoordinator serves the primary and every
 * concurrent secondary session, so they share its `sessionGeneration`.
 */
function session(repo: Repo, sessionId: string, shared?: RuntimeCoordinator) {
	const runtime = shared ?? new RuntimeCoordinator();
	runtime.projectRoot = repo.dir;
	if (!shared) runtime.setTelemetryIdentity({ sessionId });
	let n = 0;
	const callDeps = (toolName: string, input: unknown, toolCallId: string) =>
		({
			event: { toolName, toolCallId, input },
			ctx: { cwd: repo.dir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
			sessionId,
		}) as Parameters<typeof handleToolCall>[0];
	const resultDeps = (command: string, toolCallId: string) =>
		({
			event: {
				toolName: "bash",
				toolCallId,
				input: { command },
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
			sessionId,
		}) as unknown as Parameters<typeof handleToolResult>[0];
	return {
		runtime,
		/** The bash tool_call; the returned function is its tool_result. */
		async bashCall(command: string): Promise<() => Promise<void>> {
			const id = `${sessionId}-c${++n}`;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps("bash", { command }, id)),
			);
			return async () => {
				await handleToolResult(resultDeps(command, id));
			};
		},
		/** One whole bash call: tool_call, the host's run, tool_result. */
		async bash(command: string, run: () => void): Promise<void> {
			const result = await this.bashCall(command);
			run();
			await result();
		},
		async read(file: string): Promise<void> {
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					callDeps("read", { path: file }, `${sessionId}-c${++n}`),
				),
			);
		},
	};
}

/**
 * The head_moved rows whose move landed on `ref` (branch B): `repo-id.txt`
 * makes commit ids unique per repository, so no other case's row can match.
 */
async function headMovedRows(
	repo: Repo,
	ref = "B",
): Promise<Array<{ result: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const to = repo.git("rev-parse", ref).slice(0, 12);
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes('"opaque_mutation_head_moved"'))
		.map(
			(line) =>
				JSON.parse(line) as {
					result: string;
					metadata: Record<string, unknown>;
				},
		)
		.filter((row) => row.metadata.to === to);
}

/**
 * The head_moved rows once `count` have landed. The row is written when the
 * resync's detached second phase (every holding server, the drift records)
 * ends, after the hook returned.
 */
async function settledHeadMovedRows(repo: Repo, count: number, ref = "B") {
	await expect
		.poll(async () => (await headMovedRows(repo, ref)).length, {
			timeout: 30_000,
			interval: 100,
		})
		.toBe(count);
	return headMovedRows(repo, ref);
}

/** Every `phase` row in the real latency sink. */
async function phaseRows(
	phase: string,
): Promise<Array<{ filePath: string; metadata: Record<string, unknown> }>> {
	await flushLatencyLog();
	const log = path.join(getGlobalPiLensLogDir(), "latency.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.includes(`"${phase}"`))
		.map(
			(line) =>
				JSON.parse(line) as {
					filePath: string;
					metadata: Record<string, unknown>;
				},
		);
}

const TYPES_A =
	"export function isChatModel(x: unknown): boolean { return !!x; }\n";
const TYPES_B = `${TYPES_A}export function isChatModelConfig(x: unknown): boolean { return !!x; }\n`;
const MAIN =
	'import { isChatModel } from "./lib/types";\nexport const note = "one";\n';

let previousTestMode: string | undefined;
let previousDriftMs: string | undefined;

beforeAll(() => {
	// Host-boundary stub: a project-configured server needs pi's trust answer
	// (#4248 refuses it otherwise).
	setProjectTrustState("trusted");
	// latency.log writes are off under PI_LENS_TEST_MODE (#1742); the
	// head_moved row is read back from the real sink.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	// The paced drift heartbeat could heal a stale document by chance on a
	// later touch; off, only the HEAD-move resync can produce the new bytes.
	previousDriftMs = process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
	process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "0";
});

afterAll(async () => {
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	if (previousDriftMs === undefined)
		delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
	else process.env.PI_LENS_LSP_DRIFT_CHECK_MS = previousDriftMs;
	await cleanupTestEnvironmentsDrained(PREFIX, {
		beforeDrain: async () => {
			await (await lspService()).shutdown();
		},
	});
	resetProjectTrust();
});

beforeEach(() => {
	resetOpaqueMutationState();
});

describe("a clean-tree HEAD move resyncs held documents (#4493)", () => {
	// Recurrence: the reported block. `git checkout B` on a clean tree sent no
	// didChange for the held lib/types.ts, so main.ts's import of the new
	// export stayed an error until the 10 s drift heartbeat happened to run.
	it("sends a held document's new bytes before the checkout's tool_result returns, and records no mutation", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN, "lib/unheld.ts": "" },
			{ "lib/types.ts": TYPES_B, "lib/unheld.ts": "export {};\n" },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-checkout");
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(repo.git("status", "--porcelain")).toBe("");
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		// The delta is incoming content: no fileSeq bump, no change-log entry.
		expect(s.runtime.getFileSeq(repo.file("lib/types.ts"))).toBe(0);
		expect(fs.existsSync(getProjectChangeLogPath(repo.dir))).toBe(false);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			// The unheld file is in the delta but not resynced: only a held
			// document can be stale.
			result: "changed:2",
			metadata: {
				trigger: "tool_result",
				changed: 2,
				held: 1,
				resynced: 1,
				deferred: 0,
				failed: 0,
			},
		});
	}, 30_000);

	// Recurrence: review r1 F4's named output reads HEAD from the files git
	// keeps. A reftable ref store (git 2.45+) keeps no loose or packed ref, so
	// that read cannot answer; without the `git rev-parse` fallback the
	// feature would be silently off there. Skipped only where this git cannot
	// create a reftable repository.
	const reftable = (() => {
		try {
			const probe = path.join(env.tmpDir, "reftable-probe");
			fs.mkdirSync(probe, { recursive: true });
			runGit(probe, ["init", "-q", "--ref-format=reftable"]);
			return true;
		} catch {
			return false;
		}
	})();
	it("sends the new bytes before the tool_result in a repository whose refs are a reftable", async (ctx) => {
		ctx.skip(!reftable, "this git cannot create a reftable repository");
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
			["--ref-format=reftable"],
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-reftable");
		const service = await lspService();

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
	}, 30_000);

	// Recurrence: the probe's rows 3 and 4 plus the reset sibling. Each
	// completes on a clean tree and moves HEAD, so each was as invisible as
	// the checkout.
	it.each([
		{
			kind: "a completed rebase",
			setup: (repo: Repo) => {
				fs.writeFileSync(repo.file("notes.txt"), "A local\n");
				repo.git("add", "notes.txt");
				repo.git("commit", "-qm", "A local note");
			},
			command: "git rebase B",
		},
		{
			kind: "a completed cherry-pick",
			setup: () => {},
			command: "git cherry-pick B",
		},
		{
			kind: "git reset --hard",
			setup: () => {},
			command: "git reset --hard B",
		},
	])(
		"sends the new bytes before the tool_result of $kind returns",
		async ({ setup, command }) => {
			const repo = await makeRepo(
				{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
				{ "lib/types.ts": TYPES_B },
			);
			setup(repo);
			await hold(repo, ["lib/types.ts", "main.ts"]);
			const s = session(repo, `s-${command.split(" ")[1]}`);
			const service = await lspService();
			const mark = (await wire(repo, "main.ts")).length;

			await s.bash(command, () => repo.git(...command.split(" ").slice(1)));

			expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
			expect(repo.git("status", "--porcelain")).toBe("");
			expect(fs.readFileSync(repo.file("lib/types.ts"), "utf8")).toBe(TYPES_B);
			expect(await textSince(repo, mark, "main.ts")).toContain(
				textLine(repo, "lib/types.ts"),
			);
		},
		30_000,
	);

	// Recurrence: probe row 6 (the non-TypeScript screen, AGENTS.md shape 42).
	// The seam is language-neutral; a held Python document heals the same way.
	it("resyncs a held non-TypeScript document", async () => {
		const repo = await makeRepo(
			{ "app/models.py": "def is_chat_model(x):\n    return bool(x)\n" },
			{
				"app/models.py":
					"def is_chat_model(x):\n    return bool(x)\n\ndef is_chat_model_config(x):\n    return bool(x)\n",
			},
		);
		await hold(repo, ["app/models.py"]);
		const s = session(repo, "s-python");
		const service = await lspService();
		const mark = (await wire(repo, "app/models.py")).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(sentDiskBytes(service, repo, "app/models.py")).toBe(true);
		expect(await textSince(repo, mark, "app/models.py")).toContain(
			textLine(repo, "app/models.py"),
		);
	}, 30_000);

	// Recurrence: probe row 5. A checkout made outside pi emits no tool event,
	// so only the next tool_call can notice it; a read is enough.
	it("resyncs at the next turn's first tool_call after a move made outside pi", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-outside");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));
		const service = await lspService();
		const mark = (await wire(repo, "main.ts")).length;

		repo.git("checkout", "-q", "B");
		s.runtime.beginTurn("s-outside");
		await s.read(repo.file("main.ts"));

		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		expect(await textSince(repo, mark, "main.ts")).toContain(
			textLine(repo, "lib/types.ts"),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { trigger: "tool_call", resynced: 1 },
		});
	}, 30_000);

	// Recurrence: probe INJECT2. One forced pass resyncs 4 documents, so a
	// 12-document hop left 8 stale for two more 10 s heartbeats.
	it("heals a 12-document hop before the tool_result returns", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/m${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		await hold(repo, names);
		const s = session(repo, "s-twelve");
		const service = await lspService();
		const mark = (await wire(repo, names[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(names.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		const received = await textSince(repo, mark, names[0]!);
		for (const name of names) expect(received).toContain(textLine(repo, name));
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows[0]).toMatchObject({
			metadata: { held: 12, resynced: 12, deferred: 0 },
		});
	}, 60_000);

	// Recurrence: review r1 F1, the reported STOP on the default stack. The
	// resync touched each held document on every holding server in turn, so
	// the auxiliary's #1714 pacing barrier, waiting out a scanner busy with the
	// earlier didChanges, held back the PRIMARY's later didChanges past the
	// hook bound: the tool_result returned with documents stale on the primary
	// and the next edit STOPped on TS2305 (13 held files, 2 of 2 live runs).
	it("sends every changed held document to the primary before the tool_result returns, however slow the auxiliary", async () => {
		const names = Array.from(
			{ length: 12 },
			(_, i) => `lib/s${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(names.map((name) => [name, `export const v = 0;\n`])),
			Object.fromEntries(names.map((name) => [name, `export const v = 1;\n`])),
		);
		try {
			await holdWithAuxiliary(repo, names, 250);
			const s = session(repo, "s-slow-aux");
			const service = await lspService();

			await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

			expect(
				names.filter((name) => !sentDiskBytes(service, repo, name)),
			).toEqual([]);
			// The auxiliary catches up after the look; the one row lands then.
			await expect
				.poll(async () => (await headMovedRows(repo)).length, {
					timeout: 30_000,
					interval: 200,
				})
				.toBe(1);
			expect((await headMovedRows(repo))[0]).toMatchObject({
				metadata: { held: 12, primary: 12, deferred: 0 },
			});
		} finally {
			auxiliaries.delete(repo.dir);
		}
	}, 90_000);

	// Recurrence: review r1 F1, part 2. pi runs one message's tool calls in
	// parallel, so a read's tool_call can arrive while the bash's tool_result
	// look is still resending. The turn was already marked looked, so the
	// tool_call skipped the look and the read ran against the stale primary.
	it("holds a parallel tool_call until the running look has sent the move's bytes", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-join");
		s.runtime.beginTurn("s-join");
		const service = await lspService();
		const result = await s.bashCall("git checkout B");
		repo.git("checkout", "-q", "B");

		const looking = result();
		await s.read(repo.file("main.ts"));
		const sentAtRead = sentDiskBytes(service, repo, "lib/types.ts");
		await looking;

		expect(sentAtRead).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: review r1 F2 (#1687's shape). A look that joins a running
	// look must see a move made after that look read HEAD; the single-flight's
	// trailing pass is what reads it again. The shim holds the running look in
	// its `git diff` so the second move lands mid-flight.
	it("a look that joins a running look sees a move made after that look read HEAD", async (ctx) => {
		ctx.skip(
			process.platform === "win32",
			"the git shim that stalls the running look is a POSIX shell script",
		);
		// C changes a file B does not, so only a look that reads HEAD after
		// the move to C (the trailing pass) resends it: the running look's
		// delta is A..B.
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "lib/other.ts": "export const o = 0;\n" },
			{ "lib/types.ts": TYPES_B },
		);
		repo.git("checkout", "-q", "B");
		fs.writeFileSync(repo.file("lib/other.ts"), "export const o = 1;\n");
		repo.git("commit", "-qam", "C");
		repo.git("branch", "C");
		repo.git("reset", "-q", "--hard", "HEAD~1");
		repo.git("checkout", "-q", "A");
		await hold(repo, ["lib/types.ts", "lib/other.ts"]);
		const service = await lspService();
		// Host boundary: a `git` on PATH that stalls `diff` while a marker
		// exists, then runs the real git.
		const realGit = (process.env.PATH ?? "")
			.split(path.delimiter)
			.map((dir) => path.join(dir, "git"))
			.find((candidate) => fs.existsSync(candidate));
		if (!realGit) throw new Error("git is not on PATH");
		const shimDir = path.join(env.tmpDir, `git-shim-${repoCount}`);
		const slow = path.join(shimDir, "slow");
		const started = path.join(shimDir, "started");
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(
			path.join(shimDir, "git"),
			[
				"#!/bin/sh",
				`if [ "$1" = "diff" ] && [ -e ${JSON.stringify(slow)} ]; then : > ${JSON.stringify(started)}; sleep 0.4; fi`,
				`exec ${JSON.stringify(realGit)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
		try {
			const look = {
				root: repo.dir,
				key: headRecordKey("trailing", "s-trailing"),
				trigger: "tool_result" as const,
				label: "git checkout",
			};
			await resyncHeadMove(look);
			repo.git("checkout", "-q", "B");
			fs.writeFileSync(slow, "");
			const running = resyncHeadMove(look);
			await expect.poll(() => fs.existsSync(started)).toBe(true);
			repo.git("checkout", "-q", "C");
			fs.rmSync(slow);

			await resyncHeadMove(look);

			expect(sentDiskBytes(service, repo, "lib/other.ts")).toBe(true);
			await running;
		} finally {
			process.env.PATH = previousPath;
		}
	}, 30_000);

	// Recurrence: review r1 F3. The forced passes stop as soon as no queued
	// document is waiting; without that exit every move runs all 16 passes.
	it("runs one forced pass for a one-document move", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-passes");

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		const file = normalizeMapKey(repo.file("lib/types.ts"));
		const rowFor = async () =>
			(await phaseRows("lsp_external_change_resync")).find(
				(row) => normalizeMapKey(row.filePath) === file,
			);
		await expect.poll(rowFor, { timeout: 10_000 }).toBeDefined();
		expect((await rowFor())?.metadata.passes).toBe(1);
	}, 30_000);

	// Recurrence: the 512-record drift-tracker eviction dropped the record of
	// a document the server still held, so a resync driven by the records
	// would skip it. The HEAD-move targets come from the clients' open
	// documents, so the evicted document still heals before the return.
	it("resyncs a held document whose drift record was evicted", async () => {
		const held = Array.from(
			{ length: 513 },
			(_, i) => `src/f${String(i).padStart(3, "0")}.ts`,
		);
		const moved = held.slice(0, 20);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(moved.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const service = await lspService();
		const drift = (
			service as unknown as { documentDrift: { peek(file: string): unknown } }
		).documentDrift;
		// Precondition: f000's record was evicted while the server holds it.
		expect(drift.peek(repo.file(held[0]!))).toBeUndefined();
		const s = session(repo, "s-evicted");
		const mark = (await wire(repo, held[0]!)).length;

		await s.bash("git checkout B", () => repo.git("checkout", "-q", "B"));

		expect(moved.filter((name) => !sentDiskBytes(service, repo, name))).toEqual(
			[],
		);
		expect(await textSince(repo, mark, held[0]!)).toContain(
			textLine(repo, held[0]!),
		);
		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			metadata: { changed: 20, held: 20, resynced: 20, deferred: 0 },
		});
	}, 120_000);

	// Recurrence: an unbounded drain would hold the hook for a branch hop of
	// any size. The forced passes stop at 64 documents, and the one row
	// states how many the drain left to the paced heartbeat.
	it("states in the one row how many held documents the drain cap deferred", async () => {
		const held = Array.from(
			{ length: 70 },
			(_, i) => `src/g${String(i).padStart(2, "0")}.ts`,
		);
		const repo = await makeRepo(
			Object.fromEntries(held.map((name) => [name, "export const v = 0;\n"])),
			Object.fromEntries(held.map((name) => [name, "export const v = 1;\n"])),
		);
		await hold(repo, held);
		const move = {
			root: repo.dir,
			key: headRecordKey("cap", "s-cap"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(move);

		repo.git("checkout", "-q", "B");
		await resyncHeadMove(move);

		const rows = await settledHeadMovedRows(repo, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "changed:70",
			metadata: {
				changed: 70,
				held: 70,
				primary: 64,
				resynced: 64,
				deferred: 6,
			},
		});
	}, 120_000);

	// Recurrence: queued targets are resent unconditionally, so every agent
	// `git commit` (a HEAD move whose files the server already holds) would
	// resend each committed held document and its importers.
	it("resends nothing when the move leaves the held bytes current, as a commit does", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		fs.writeFileSync(repo.file("lib/types.ts"), TYPES_B);
		await hold(repo, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-commit");
		const mark = (await wire(repo, "main.ts")).length;

		await s.bash("git commit -qam types", () =>
			repo.git("commit", "-qam", "types"),
		);

		expect(await textSince(repo, mark, "main.ts")).toEqual([]);
		const rows = await settledHeadMovedRows(repo, 1, "HEAD");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			result: "changed:1",
			metadata: { held: 1, current: 1, resynced: 0 },
		});
	}, 30_000);

	// Recurrence: a session's parallel bash calls look concurrently. A look
	// that saw no move (its sibling's look claimed it) returned at once, while
	// the sibling was still resending, so that tool_result came back with the
	// held document stale. Looks of one session run one at a time, and a look
	// arriving mid-flight returns only after the flight's resync.
	it("returns no concurrent look of a session before the move's resync is sent", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const service = await lspService();
		const look = {
			root: repo.dir,
			key: headRecordKey("race", "s-race"),
			trigger: "tool_result" as const,
			label: "git checkout B",
		};
		await resyncHeadMove(look);
		repo.git("checkout", "-q", "B");

		const first = await Promise.race([
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
			resyncHeadMove(look).then(() =>
				sentDiskBytes(service, repo, "lib/types.ts"),
			),
		]);

		expect(first).toBe(true);
		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);

	// Recurrence: a failed or truncated `git diff` read as an empty delta would
	// report "nothing changed" for a move whose documents stayed stale. The
	// row says the delta is unknown instead (an old HEAD a gc pruned, here a
	// commit id the repository never had).
	it("states delta-unknown and resends the held documents that differ from disk when the old HEAD cannot be diffed", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const move = {
			root: repo.dir,
			key: headRecordKey("gone", "s-gone"),
			trigger: "tool_call" as const,
			label: "read",
		};
		observeGitHead(move.key, "c".repeat(40));
		repo.git("checkout", "-q", "B");

		const service = await lspService();

		await resyncHeadMove(move);

		// Review r1 F6 (shape 48): the delta is unknown but the held set is
		// not, so the held documents whose bytes differ from disk are resent.
		expect(sentDiskBytes(service, repo, "lib/types.ts")).toBe(true);
		await expect.poll(async () => (await headMovedRows(repo)).length).toBe(1);
		expect((await headMovedRows(repo))[0]).toMatchObject({
			result: "delta-unknown",
			metadata: { changed: -1, held: 1 },
		});
	}, 30_000);

	// Recurrence: a shared record would let one session's observation answer
	// for another's; each session keeps its own HEAD record, so a concurrent
	// session sees the move at its own next call. The two sessions share one
	// coordinator, as in index.ts, so only the session id tells them apart.
	it("keeps one HEAD record per session: a second session sees the move at its own call", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const primary = session(repo, "s-primary");
		const secondary = session(repo, "s-secondary", primary.runtime);
		await secondary.bash("true", () => {});

		await primary.bash("git checkout B", () => repo.git("checkout", "-q", "B"));
		await secondary.read(repo.file("main.ts"));

		const rows = await settledHeadMovedRows(repo, 2);
		expect(rows.map((row) => row.metadata.trigger)).toEqual([
			"tool_result",
			"tool_call",
		]);
	}, 30_000);

	// Recurrence: pi runs the bash calls of one message in parallel, so every
	// tool_call precedes the first tool_result. One move is one row.
	it("records one move once when parallel bash calls share it", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		await hold(repo, ["lib/types.ts"]);
		const s = session(repo, "s-parallel");
		const first = await s.bashCall("git checkout B");
		const second = await s.bashCall("ls");
		repo.git("checkout", "-q", "B");

		await first();
		await second();

		expect(await settledHeadMovedRows(repo, 1)).toHaveLength(1);
	}, 30_000);
});

describe("the per-session HEAD records (#4493)", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);

	// Recurrence: a record per (slot, session) grows with every cwd and every
	// session a long-lived process sees; the store is capped at 64, and a
	// session that keeps looking keeps its record while idle ones age out.
	it("keeps 64 records, refreshing the one a session observes again", () => {
		for (let i = 0; i < 64; i++) observeGitHead(`k${i}`, A);
		observeGitHead("k0", A);
		observeGitHead("k64", A);

		// k0 was refreshed, so it still reports the move; k1 was the oldest and
		// went, so its next look is a first sight, not a move.
		expect(observeGitHead("k0", B)).toBe(A);
		expect(observeGitHead("k1", B)).toBeUndefined();
	});
});

describe("opaque recovery from a subdirectory (#4493 residual 3)", () => {
	// Recurrence: `git status --porcelain` prints paths relative to the
	// repository root, and recovery resolved them against the session's cwd:
	// from a subdirectory every dirty path pointed below itself and was
	// dropped as vanished, so an opaque write there resynced nothing.
	it("recovers a dirty path when the cwd is a subdirectory of the repository", async () => {
		const repo = await makeRepo(
			{ "sub/x.ts": "export const x = 0;\n" },
			{ "sub/x.ts": "export const x = 1;\n" },
		);
		const startedAt = Date.now();
		fs.writeFileSync(repo.file("sub/x.ts"), "export const x = 2;\n");

		const outcome = await recoverOpaqueChangesViaGit(
			repo.file("sub"),
			startedAt,
		);

		expect(outcome.paths).toEqual([normalizeMapKey(repo.file("sub/x.ts"))]);
	}, 30_000);
});
