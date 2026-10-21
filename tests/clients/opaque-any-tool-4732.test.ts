// flake-shape: real-process-spawn — the cost under test is the real `git status` children each tool call spawns, counted at the spawn boundary; a stubbed git would answer only the count it was given.
/**
 * #4732: the opaque before/after diff runs for every tool call that is not
 * known to be read-only or structured, not only for `bash`.
 *
 * Recurrence prevented: the gate admitted one known writer by name
 * (`toolName === "bash"`) and skipped every other tool, so a file written by
 * another extension's tool, an MCP tool routed through pi, or the outer
 * codemode call was never diffed and never reached a diagnostic. Unknown must
 * mean opaque.
 *
 * Real here: `handleToolCall` and `handleToolResult` (the bodies `index.ts`
 * registers), the runtime coordinator, the opaque baseline store, and a real
 * git repository. The one double is at the process boundary: `safeSpawnAsync`
 * passes every call through to the real spawn and records its argv, so the
 * table below can count the `git status` children each call costs; one case
 * makes the post-call `git status` exit 128, as a broken repository does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
	argv: [] as string[][],
	/** 1-based: this and every later `git status` exits 128 (git failed). */
	failStatusFrom: Number.POSITIVE_INFINITY,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			(...args: Parameters<typeof actual.safeSpawnAsync>) => {
				spawned.argv.push([args[0], ...(args[1] ?? [])]);
				const statuses = spawned.argv.filter(
					(argv) => argv[0] === "git" && argv[1] === "status",
				).length;
				if (
					args[0] === "git" &&
					args[1]?.[0] === "status" &&
					statuses >= spawned.failStatusFrom
				)
					return Promise.resolve({
						stdout: "",
						stderr: "fatal: probe",
						status: 128,
					});
				return actual.safeSpawnAsync(...args);
			},
		),
	};
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	resetOpaqueMutationState,
	shouldRunOpaqueRecovery,
} from "../../clients/opaque-mutation-scan.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { execSync } from "../support/git-fixture-env.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { removeTempDirSync } from "./test-utils.js";

describe("shouldRunOpaqueRecovery: an unknown tool is opaque (#4732)", () => {
	const root = path.join(os.tmpdir(), "pi-lens-opaque-any-tool-gate");
	// Expected values are written out here, not read from the production
	// tables: a row that moves between the lists must red this table.
	it.each([
		// Unknown names: another extension's tool, an MCP tool via pi, codemode.
		["some_ext_tool", true],
		["codemode", true],
		["mcp__github__create_or_update_file", true],
		// An MCP-only pi-lens registry name is a third-party name on pi.
		["pilens_analyze", true],
		// A name that is a property of every object is still just a name.
		["constructor", true],
		// pi's shells write whatever their command does.
		["bash", true],
		["powershell", true],
		// pi's read-only built-ins.
		["read", false],
		["grep", false],
		["find", false],
		["ls", false],
		// pi's structured writers: the classified chain records their path.
		["write", false],
		["edit", false],
		// pi-lens's own tools: read-only, or writing through the mutation bridge.
		["symbol_search", false],
		["module_report", false],
		["ast_grep_replace", false],
		["lsp_navigation", false],
		["lens_diagnostic_mark", false],
	])("answers %s with %s", (toolName, expected) => {
		expect(shouldRunOpaqueRecovery(toolName, root)).toBe(expected);
	});

	it("never runs without a root", () => {
		expect(shouldRunOpaqueRecovery("some_ext_tool", undefined)).toBe(false);
	});
});

describe("which calls pay for git status (#4732)", () => {
	let tmpRoot = "";
	let repoDir = "";
	const originalTestMode = process.env.PI_LENS_TEST_MODE;
	const originalDataDir = process.env.PILENS_DATA_DIR;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-any-tool-"),
		);
		repoDir = path.join(tmpRoot, "repo");
		fs.mkdirSync(repoDir);
		fs.writeFileSync(path.join(repoDir, "seed.ts"), "export const seed = 1;\n");
		execSync(
			"git init -q && git config user.email t@t.local && git config user.name t && git add -A && git commit -qm base",
			{ cwd: repoDir },
		);
		// Project data outside the repository, so a data write is never a
		// working-tree change of the command under test.
		process.env.PILENS_DATA_DIR = path.join(tmpRoot, "data");
		// The phase rows this table reads are real only outside test mode.
		process.env.PI_LENS_TEST_MODE = "0";
		resetOpaqueMutationState();
		resetDegradationLedger();
		spawned.argv.length = 0;
		spawned.failStatusFrom = Number.POSITIVE_INFINITY;
	});

	afterEach(() => {
		if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = originalTestMode;
		if (originalDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = originalDataDir;
		resetOpaqueMutationState();
		resetDegradationLedger();
		removeTempDirSync(tmpRoot);
	});

	function runtimeFor(sessionId: string): RuntimeCoordinator {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId });
		return runtime;
	}

	function callDeps(
		runtime: RuntimeCoordinator,
		event: Record<string, unknown>,
	): Parameters<typeof handleToolCall>[0] {
		return {
			event,
			ctx: { cwd: repoDir },
			lensEnabled: true,
			getFlag: (flag: string) => flag === "no-lsp",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0];
	}

	function resultDeps(
		runtime: RuntimeCoordinator,
		event: Record<string, unknown>,
	): Parameters<typeof handleToolResult>[0] {
		return {
			event: { content: [{ type: "text", text: "ok" }], ...event },
			getFlag: (flag: string) => flag === "no-lsp",
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
		} as unknown as Parameters<typeof handleToolResult>[0];
	}

	function gitStatusSpawns(): number {
		return spawned.argv.filter(
			(argv) => argv[0] === "git" && argv[1] === "status",
		).length;
	}

	/** The `opaque_mutation_prescan` rows this case added, by label. */
	async function prescanRowsSince(offset: number): Promise<string[]> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath)
			? fs.readFileSync(logPath, "utf8").slice(offset)
			: "";
		const scratch = path.join(tmpRoot, "latency-tail.ndjson");
		fs.writeFileSync(scratch, text);
		const read = readNdjsonRows<{ phase?: string; filePath?: string }>(scratch);
		expect(read.skipped).toBe(0);
		return read.rows
			.filter((row) => row.phase === "opaque_mutation_prescan")
			.map((row) => row.filePath ?? "");
	}

	async function latencyOffset(): Promise<number> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
	}

	const seed = () => path.join(repoDir, "seed.ts");

	// [label, toolName, input, isError at the result, git status children].
	// A captured call costs two: the dirty set before it runs and the
	// recovery after it. The repository is clean, so the same-HEAD discard
	// read (a third) never runs.
	it.each<[string, string, () => Record<string, unknown>, boolean, number]>([
		[
			"an unknown extension tool",
			"some_ext_tool",
			() => ({ query: "x" }),
			false,
			2,
		],
		[
			"the outer codemode call",
			"codemode",
			() => ({ code: "await bash({})" }),
			false,
			2,
		],
		[
			"an MCP tool routed through pi",
			"mcp__fs__write_file",
			() => ({ content: "x" }),
			false,
			2,
		],
		[
			"bash (control: unchanged)",
			"bash",
			() => ({ command: "node -e ''" }),
			false,
			2,
		],
		["pi's read", "read", () => ({ path: seed() }), false, 0],
		["pi's grep", "grep", () => ({ pattern: "seed", path: repoDir }), false, 0],
		["pi's ls", "ls", () => ({ path: repoDir }), false, 0],
		// The classified chain would dispatch a successful structured result;
		// a failed one returns before the pipeline, after every opaque gate.
		["pi's write", "write", () => ({ path: seed(), content: "x\n" }), true, 0],
		[
			"pi's edit",
			"edit",
			() => ({ path: seed(), edits: [{ oldText: "1", newText: "2" }] }),
			true,
			0,
		],
		[
			"a third-party tool the shape adapters classify",
			"hashline_edit",
			() => ({
				path: seed(),
				operations: [{ set_line: { anchor: "1", new_text: "x" } }],
			}),
			true,
			0,
		],
		[
			"a pi-lens read-only tool",
			"symbol_search",
			() => ({ query: "seed" }),
			false,
			0,
		],
		[
			"a pi-lens tool that writes through the bridge",
			"ast_grep_replace",
			() => ({ pattern: "a", rewrite: "b", apply: false }),
			false,
			0,
		],
	])(
		"%s spawns the expected git status children",
		{ timeout: 30_000 },
		async (_label, toolName, input, isError, expected) => {
			const runtime = runtimeFor(`4732-table-${toolName}`);
			const toolCallId = `4732-${toolName}-1`;
			const offset = await latencyOffset();
			const event = { toolName, toolCallId, input: input() };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			await handleToolResult(
				resultDeps(runtime, {
					...event,
					...(isError ? { isError: true } : {}),
				}),
			);
			expect(gitStatusSpawns()).toBe(expected);
			// Acceptance: an allowlisted call records no new latency phase; a
			// captured one records exactly its own prescan row.
			const label = toolName === "bash" ? "node -e ''" : toolName;
			expect(await prescanRowsSince(offset)).toEqual(
				expected > 0 ? [label] : [],
			);
		},
	);

	// The captured call's writes went unseen, and nothing else would say so:
	// bash names the same verdict through its coverage row and its withheld
	// blockers, so only a non-bash call records it.
	it("names a captured call whose diff git could not answer", async () => {
		const runtime = runtimeFor("4732-git-failed");
		// The baseline's dirty set is status 1; the recovery's is status 2.
		spawned.failStatusFrom = 2;
		const event = {
			toolName: "some_ext_tool",
			toolCallId: "4732-git-failed-1",
			input: { query: "x" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, event)),
		);
		await handleToolResult(resultDeps(runtime, event));
		const refused = () =>
			getDegradationSummary().find(
				(group) => group.kind === "opaque-capture-refused",
			);
		expect(refused()?.latestReasons.map((entry) => entry.subject)).toEqual([
			"git-failed",
		]);

		resetDegradationLedger();
		spawned.argv.length = 0;
		const bash = {
			toolName: "bash",
			toolCallId: "4732-git-failed-bash",
			input: { command: "node -e ''" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall(callDeps(runtime, bash)),
		);
		await handleToolResult(resultDeps(runtime, bash));
		expect(gitStatusSpawns()).toBe(2);
		expect(refused()).toBeUndefined();
	});

	it("refuses a non-bash call with no tool-call id, once per session", async () => {
		const runtime = runtimeFor("4732-no-id");
		for (const _ of [1, 2]) {
			const event = { toolName: "some_ext_tool", input: { query: "x" } };
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(callDeps(runtime, event)),
			);
			await handleToolResult(resultDeps(runtime, event));
		}
		// A host with no ids shares one slot with bash; a non-bash take there
		// would steal bash's baseline, so the call is refused and said so.
		expect(gitStatusSpawns()).toBe(0);
		const refused = getDegradationSummary().find(
			(group) => group.kind === "opaque-capture-refused",
		);
		expect(refused?.count).toBe(1);
		expect(refused?.latestReasons.map((entry) => entry.subject)).toEqual([
			"no-tool-call-id",
		]);
	});
});
