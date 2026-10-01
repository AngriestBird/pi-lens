// flake-shape: real-process-spawn — real `git worktree add` / `git submodule add` children write the linked-worktree `.git` files and the `worktrees/*/gitdir` registry that checkout ownership is read from; an in-process stub would only restate the assumption under test

/**
 * #3871: turn_end test selection runs in the checkout that OWNS the edit.
 *
 * Recurrence prevented (live session 01a0f1c5, 2026-09-30, 191 of 196 edits in
 * `.worktrees/*`, session cwd = the main checkout): after #3649 every edit in a
 * linked worktree resolved its test against the session checkout and then lost
 * the foreign-checkout gate. `turn_end: firing N test target(s)` went from 44
 * (B2a) to 0 (B3), `test target excluded by the built-in turn-end policy`
 * named two edited worktree test files, and a worktree source whose name also
 * existed under the session's `tests/` would have run the SESSION's test for a
 * worktree edit. The #3649 failed-first crossover (35 of 39 failed-first runs
 * replayed another worktree's failing file) must stay closed.
 *
 * Every case drives the real `handleTurnEnd`, the real `TestRunnerClient` and
 * the real `CacheManager` over REAL git worktrees. The one thing faked is the
 * test process (`safeSpawnAsync`): a recorder that returns a vitest-shaped
 * result for the test file named in its args, so the assertions read what the
 * production code asked the runner to do (command, cwd, file), not what it
 * believed.
 *
 * Boundary decision (flake-shape): no real test runner spawn and no wall-clock
 * wait; the batch is awaited through the production `runTestFileAsync` promises.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The latency writer captures its path at import time, including through
// transitive imports: pin the home before any client module loads.
const logHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = mkdtempSync(join(tmpdir(), "pi-lens-3871-log-"));
	vi.stubEnv("PI_LENS_HOME", home);
	return home;
});

const runner = vi.hoisted(() => ({
	spawns: [] as Array<{ command: string; args: string[]; cwd: string }>,
	/** Absolute test files whose spawn reports one failing test. */
	failing: new Set<string>(),
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(
		async (command: string, args: string[], options?: { cwd?: string }) => {
			const testFile = args.find((arg) => /\.test\.ts$/.test(arg));
			if (testFile === undefined) return { stdout: "", stderr: "", status: 0 };
			runner.spawns.push({ command, args, cwd: options?.cwd ?? "" });
			const failed = runner.failing.has(path.resolve(testFile)) ? 1 : 0;
			return {
				stdout: JSON.stringify({
					numFailedTests: failed,
					numPassedTests: failed ? 0 : 1,
					testResults: [],
				}),
				stderr: "",
				status: failed ? 1 : 0,
			};
		},
	),
}));
vi.mock("../../clients/sessionstart-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/sessionstart-logger.js")
	>()),
	logSessionStart: vi.fn(),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetInstanceRegistryEnabledForTests } from "../../clients/instance-registry.js";
import { KnipClient } from "../../clients/knip-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { MAX_LINKED_TEST_ROOTS_PER_TURN } from "../../clients/test-target-roots.js";
import {
	isExcludedTestTarget,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const SESSION = "test-root-session";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
let client: TestRunnerClient;
let main: string;
let dbgLines: string[];
let runCalls: { mock: { results: Array<{ value: unknown }> } };

function git(cwd: string, ...args: string[]): void {
	gitExecFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function write(dir: string, relative: string, content: string): string {
	const file = path.join(dir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/**
 * The runner shim a checkout owns: `resolveExec` prefers
 * `<root>/node_modules/.bin/vitest`, so which shim a spawn names is which
 * checkout's own `node_modules` resolved the runner.
 */
function installRunnerShim(root: string): string {
	const bin = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	const shim = path.join(bin, "vitest");
	fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(shim, 0o755);
	return shim;
}

/** A real repository: a vitest config, a source file and its companion test. `.worktrees/` is NOT ignored (the plegma shape). */
function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "t");
	write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
	write(dir, "vitest.config.ts", "export default {};\n");
	write(dir, "src/widget.ts", "export const widget = 1;\n");
	write(dir, "tests/widget.test.ts", "export {};\n");
	write(dir, "tests/unit/self.test.ts", "export {};\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
	installRunnerShim(dir);
}

function addWorktree(name: string): string {
	const dir = path.join(main, ".worktrees", name);
	git(main, "worktree", "add", "-q", "-b", name, dir);
	installRunnerShim(dir);
	return dir;
}

/** The agent wrote `file`: the worklist row turn_end reads, plus the runtime's own seq bump. */
function edit(file: string): void {
	runtime.recordProjectMutation({ filePath: file, source: "agent-edit" });
	cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		main,
		SESSION,
	);
}

async function turnEnd(): Promise<void> {
	await handleTurnEnd({
		ctxCwd: main,
		getFlag: () => false,
		dbg: (line: string) => dbgLines.push(line),
		runtime,
		cacheManager,
		knipClient: new KnipClient(false),
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: client,
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as unknown as Parameters<typeof handleTurnEnd>[0]);
}

/**
 * The turn's test batch is fired without being awaited. Its runner promises are
 * the production `runTestFileAsync` calls (spied, not replaced), so awaiting
 * them is awaiting the real runs: the process boundary is already settled, and
 * the failed-target record is written inside each call before it resolves.
 */
async function batchSettled(spawnCount: number): Promise<void> {
	await Promise.allSettled(
		runCalls.mock.results.map((call) => call.value as Promise<unknown>),
	);
	expect(runner.spawns).toHaveLength(spawnCount);
}

function spawned(): Array<{ cwd: string; file: string; command: string }> {
	return runner.spawns.map((spawn) => ({
		cwd: fs.realpathSync.native(spawn.cwd),
		file: fs.realpathSync.native(
			spawn.args.find((arg) => /\.test\.ts$/.test(arg)) as string,
		),
		command: spawn.command,
	}));
}

function real(p: string): string {
	return fs.realpathSync.native(p);
}

/** The durable `test-target-foreign-checkout` rows (metadata is only on the log, not the in-memory summary). */
async function foreignRows(): Promise<Array<Record<string, unknown>>> {
	await flushLatencyLog();
	const log = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return log
		.split("\n")
		.filter((line) => line.includes('"kind":"test-target-foreign-checkout"'))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	_resetInstanceRegistryEnabledForTests();
});
afterAll(async () => {
	await flushLatencyLog();
	removeTempDirSync(logHome);
	vi.unstubAllEnvs();
	_resetInstanceRegistryEnabledForTests();
});

beforeEach(async () => {
	resetDegradationLedger();
	clearLatencyLog();
	await flushLatencyLog();
	runner.spawns.length = 0;
	runner.failing.clear();
	dbgLines = [];
	env = setupTestEnvironment("pi-lens-3871-test-root-");
	vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
	main = path.join(env.tmpDir, "main");
	initRepo(main);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = main;
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	cacheManager = new CacheManager(false);
	client = new TestRunnerClient(false);
	runCalls = vi.spyOn(client, "runTestFileAsync");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	vi.stubEnv("PI_LENS_HOME", logHome);
	env.cleanup();
});

describe("#3871 test root: the checkout that owns the edit", () => {
	it("runs a linked worktree's edited test in that worktree, with its own runner install", async () => {
		const x = addWorktree("x");
		const xTest = path.join(x, "tests", "unit", "self.test.ts");
		edit(xTest);

		await turnEnd();
		await batchSettled(1);

		expect(spawned()).toEqual([
			{
				cwd: real(x),
				file: real(xTest),
				command: path.join(real(x), "node_modules", ".bin", "vitest"),
			},
		]);
	});

	it("selects a worktree source's own companion, never the session checkout's same-named test", async () => {
		// main has tests/widget.test.ts too: resolving against the session cwd
		// would run THAT file for an edit in x.
		const x = addWorktree("x");
		edit(path.join(x, "src", "widget.ts"));

		await turnEnd();
		await batchSettled(1);

		expect(spawned().map((spawn) => spawn.file)).toEqual([
			real(path.join(x, "tests", "widget.test.ts")),
		]);
		expect(spawned()[0]?.cwd).toBe(real(x));
	});

	it("leaves an edit in the session checkout exactly as before", async () => {
		addWorktree("x");
		const mainTest = path.join(main, "tests", "unit", "self.test.ts");
		edit(mainTest);

		await turnEnd();
		await batchSettled(1);

		expect(spawned()).toEqual([
			{
				cwd: real(main),
				file: real(mainTest),
				command: path.join(real(main), "node_modules", ".bin", "vitest"),
			},
		]);
	});

	it("runs each edited checkout's tests in its own root in one turn", async () => {
		const x = addWorktree("x");
		const y = addWorktree("y");
		edit(path.join(main, "tests", "unit", "self.test.ts"));
		edit(path.join(x, "tests", "unit", "self.test.ts"));
		edit(path.join(y, "tests", "unit", "self.test.ts"));

		await turnEnd();
		await batchSettled(3);

		const byRoot = new Map(spawned().map((spawn) => [spawn.cwd, spawn.file]));
		expect(byRoot.get(real(main))).toBe(
			real(path.join(main, "tests", "unit", "self.test.ts")),
		);
		expect(byRoot.get(real(x))).toBe(
			real(path.join(x, "tests", "unit", "self.test.ts")),
		);
		expect(byRoot.get(real(y))).toBe(
			real(path.join(y, "tests", "unit", "self.test.ts")),
		);
	});

	describe("the #3649 failed-first crossover stays closed", () => {
		it("does not replay a failing worktree test for an edit in a sibling worktree or the session checkout", async () => {
			const x = addWorktree("x");
			const y = addWorktree("y");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([real(xTest)]);

			// Turn 2: an unrelated source edit in y. x's recorded failure must not
			// be selected for it.
			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(y, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([
				real(path.join(y, "tests", "widget.test.ts")),
			]);

			// Turn 3: the session checkout.
			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(main, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);
			expect(spawned().map((spawn) => spawn.file)).toEqual([
				real(path.join(main, "tests", "widget.test.ts")),
			]);
		});

		it("still replays the worktree's own failure first for the next edit in that worktree", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			runner.failing.add(xTest);
			edit(xTest);
			await turnEnd();
			await batchSettled(1);

			runner.spawns.length = 0;
			dbgLines.length = 0;
			runtime.beginTurn();
			edit(path.join(x, "src", "widget.ts"));
			await turnEnd();
			await batchSettled(1);

			expect(spawned()).toEqual([
				expect.objectContaining({ cwd: real(x), file: real(xTest) }),
			]);
			expect(dbgLines.join("\n")).toContain("(failed-first)");
		});

		it("rejects a sibling worktree's test against the session root and says it shares the repository", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");

			expect(isExcludedTestTarget(xTest, main)).toBe(true);
			expect(isExcludedTestTarget(xTest, x)).toBe(false);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "true" }),
				}),
			]);
		});
	});

	describe("independent checkouts keep today's exclusion", () => {
		it("excludes a nested independent clone's test and records sameCommonDir false", async () => {
			const clone = path.join(main, "vendor-clone");
			initRepo(clone);
			edit(path.join(clone, "tests", "unit", "self.test.ts"));

			await turnEnd();

			expect(runner.spawns).toEqual([]);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "false" }),
				}),
			]);
		});

		it("excludes a submodule's test and records sameCommonDir false", async () => {
			const upstream = path.join(env.tmpDir, "upstream");
			initRepo(upstream);
			git(
				main,
				"-c",
				"protocol.file.allow=always",
				"submodule",
				"add",
				"-q",
				upstream,
				"sub",
			);
			installRunnerShim(path.join(main, "sub"));
			edit(path.join(main, "sub", "tests", "unit", "self.test.ts"));

			await turnEnd();

			expect(runner.spawns).toEqual([]);
			expect(await foreignRows()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({ sameCommonDir: "false" }),
				}),
			]);
		});
	});

	describe("per-turn cost bound", () => {
		it("selects tests in at most the capped number of linked worktrees and counts the rest", async () => {
			const worktrees = ["w1", "w2", "w3", "w4"].map(addWorktree);
			expect(worktrees).toHaveLength(MAX_LINKED_TEST_ROOTS_PER_TURN + 1);
			for (const dir of worktrees)
				edit(path.join(dir, "tests", "unit", "self.test.ts"));
			edit(path.join(worktrees[0] as string, "src", "widget.ts"));

			await turnEnd();
			// w1 has two targets (its own test and the source's companion), w2 and w3
			// one each; w4 is over the cap of three roots.
			await batchSettled(MAX_LINKED_TEST_ROOTS_PER_TURN + 1);

			expect([...new Set(spawned().map((spawn) => spawn.cwd))].sort()).toEqual(
				worktrees
					.slice(0, MAX_LINKED_TEST_ROOTS_PER_TURN)
					.map((dir) => real(dir))
					.sort(),
			);
			const skipped = getDegradationSummary().find(
				(group) => group.kind === "turn-end-test-root-skipped",
			);
			expect(skipped?.count).toBe(1);
			expect(JSON.stringify(skipped)).toContain("root-cap");
			expect(JSON.stringify(skipped)).toContain(".worktrees/w4");
		});
	});

	describe("a carried deferred target", () => {
		it("re-runs in the linked worktree that owns it", async () => {
			const x = addWorktree("x");
			const xTest = path.join(x, "tests", "unit", "self.test.ts");
			cacheManager.writeCache(
				"test-runner-findings",
				{
					content: "deferred",
					deferredTargets: [
						{
							testFile: xTest,
							runner: "vitest",
							attempts: 1,
							sessionId: runtime.telemetrySessionId,
						},
					],
				},
				main,
			);
			// An edit with no companion test: the carried target is the only work.
			write(main, "src/lonely.ts", "export const lonely = 1;\n");
			edit(path.join(main, "src", "lonely.ts"));

			await turnEnd();
			await batchSettled(1);

			expect(spawned()).toEqual([
				expect.objectContaining({ cwd: real(x), file: real(xTest) }),
			]);
		});
	});
});
