/**
 * Tool-state matrix (#4522): only a clean run may read clean.
 *
 * Premise. The detection retro of 2026-10-16 counted 29 bugs where a tool that
 * had not answered (missing, crashed, timed out, the wrong version) read as a
 * clean file (cluster K4: #4451, #4453, #4454, #4455, #4485, #4486, #4487,
 * #4465, #4322, #4166). Each was found and fixed one runner at a time, because
 * no test asked every runner the same question. This one does.
 *
 * For every registered CLI runner that has captured real-binary bytes
 * (`tests/fixtures/runner-output/`), the production dispatcher
 * (`dispatchForFile` over a registry from `registerDefaultRunners`) runs the
 * runner against each of these tool states, and the verdict is read from the
 * dispatcher's own result (`diagnostics`, `inconclusiveSources`,
 * `unconfirmedStatus`) and its own `reachedNoVerdict` rule:
 *
 *   clean            probe ok; the run prints nothing / the empty report
 *   dirty            probe ok; the run prints the captured real bytes
 *   missing          every spawn fails ENOENT (no binary)
 *   crashed          the run dies of SIGSEGV, or exits 101 on a panic
 *   wrong-version    the probe rejects its flag (helm 4 / spotbugs 4 shape,
 *                    #4453), or every call exits 2 with a usage error
 *   unanswered       the run, or the probe, exhausts its spawn budget
 *
 * Only `clean` may yield a clean verdict, and `dirty` must yield findings. The
 * `clean` cell is also the harness control: it proves the runner reached its
 * work spawn, so a harness that never gets there cannot pass the other cells
 * vacuously.
 *
 * Only the process boundary is replaced (`safeSpawnAsync`, a member of the
 * flake-shape ratchet's PROCESS_BOUNDARY_MODULES). The availability checker,
 * the install resolver, the runner, and the dispatcher are real. Every cell
 * loads a fresh module graph: several clients keep process-wide memos of a
 * tool's presence (`goClient`), and one cell's answer must not decide the next.
 *
 * Out of scope here, by the census in `smoke-fixture-coverage.test.ts`: runners
 * with no captured bytes (in-process, LSP-relayed, or exempt there with a
 * category), which have no real output to put in the `dirty` cell.
 *
 * Capture-side availability provenance (#4473: each capture recording the real
 * tool's own answer to the probe) stays its own lane; the matrix probes the
 * real checker against the probe answers modelled below.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DispatchResult,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import {
	type CapturedOutput,
	listCapturedOutputs,
	materialize,
	WORKSPACE_TOKEN,
} from "../../helpers/captured-runner-output.js";
import { setupTestEnvironment } from "../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

type Call = "probe" | "work";
type SpawnAnswer = Record<string, unknown>;
type Verdict = "clean" | "findings" | "no-verdict";

interface AnswerContext {
	fixture: CapturedOutput;
	workspace: string;
	classify: (error: Error, cmd: string) => Promise<unknown>;
	SpawnFailureError: typeof import("../../../clients/safe-spawn.js").SpawnFailureError;
}

interface Cell {
	name: string;
	/**
	 * `no-verdict`: the tool never answered about the file, so the run may state
	 * neither that it is clean nor a finding. `not-clean`: the tool answered
	 * with an exit the runner classifies by its own table, so only the clean
	 * reading is excluded.
	 */
	expect: Verdict | "not-clean";
	answer(call: Call, cmd: string, ctx: AnswerContext): Promise<SpawnAnswer>;
}

const ok = (stdout = "tool 1.2.3\n"): SpawnAnswer => ({
	error: null,
	status: 0,
	stdout,
	stderr: "",
});

/** What a tool prints on a clean run; biome's JSON report needs its empty form. */
function cleanBytes(fixture: CapturedOutput): string {
	if (fixture.provenance.runner !== "biome-check-json") return "";
	// Derived from the captured real report: the same document with its
	// findings removed, not an invented shape.
	const report = JSON.parse(fixture.stdout) as {
		summary: Record<string, number>;
		diagnostics: unknown[];
	};
	report.diagnostics = [];
	report.summary.warnings = 0;
	report.summary.errors = 0;
	return JSON.stringify(report);
}

async function enoent(cmd: string, ctx: AnswerContext): Promise<SpawnAnswer> {
	const error = Object.assign(new Error(`spawn ${cmd} ENOENT`), {
		code: "ENOENT",
	});
	return {
		stdout: "",
		stderr: "",
		status: null,
		error,
		failure: "spawn",
		spawnFailure: await ctx.classify(error, cmd),
	};
}

function signalDeath(ctx: AnswerContext): SpawnAnswer {
	const error = new Error("Process killed by signal: SIGSEGV");
	return {
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGSEGV",
		error,
		failure: "signal",
		spawnFailure: new ctx.SpawnFailureError("killed", error.message, error),
	};
}

function timedOut(ctx: AnswerContext, ms: number): SpawnAnswer {
	const error = new Error(
		`Process timed out after ${ms}ms (killed with SIGTERM)`,
	);
	return {
		stdout: "",
		stderr: "",
		status: null,
		error,
		failure: "timeout",
		spawnFailure: new ctx.SpawnFailureError("timeout", error.message, error),
	};
}

const rejectedFlag: SpawnAnswer = {
	error: null,
	status: 1,
	stdout: "",
	stderr: "Error: unknown flag: --version\n",
};

const usageError: SpawnAnswer = {
	error: null,
	status: 2,
	stdout: "",
	stderr: "Error: unknown flag: --format\nUsage:\n  tool [flags] <file>\n",
};

const CELLS: Cell[] = [
	{
		name: "clean",
		expect: "clean",
		async answer(call, _cmd, ctx) {
			return call === "probe" ? ok() : ok(cleanBytes(ctx.fixture));
		},
	},
	{
		name: "dirty",
		expect: "findings",
		async answer(call, _cmd, ctx) {
			return call === "probe" ? ok() : materialize(ctx.fixture, ctx.workspace);
		},
	},
	{
		name: "missing",
		expect: "no-verdict",
		answer: (_call, cmd, ctx) => enoent(cmd, ctx),
	},
	{
		name: "crashed (killed by SIGSEGV)",
		expect: "no-verdict",
		async answer(call, _cmd, ctx) {
			return call === "probe" ? ok() : signalDeath(ctx);
		},
	},
	{
		name: "crashed (panic, exit 101)",
		expect: "not-clean",
		async answer(call) {
			return call === "probe"
				? ok()
				: {
						error: null,
						status: 101,
						stdout: "",
						// Tool-neutral on purpose: a panic that quotes `file:line:col`
						// is a parser question of its own, not a crash cell.
						stderr: "fatal: internal error: unexpected failure\n",
					};
		},
	},
	{
		// helm 4.3.0 and spotbugs 4.10.2 reject `--version` (#4453, #4473). The
		// work answer is clean on purpose: the only thing that keeps this cell
		// from reading clean is honouring the rejected probe.
		name: "wrong version (probe rejected)",
		expect: "no-verdict",
		async answer(call, _cmd, ctx) {
			return call === "probe" ? rejectedFlag : ok(cleanBytes(ctx.fixture));
		},
	},
	{
		// A tool whose runner never probes meets the other face of the same
		// state: an older or newer CLI refuses the flags the runner passes.
		name: "wrong version (usage error)",
		expect: "not-clean",
		answer: async () => usageError,
	},
	{
		name: "unanswered (run exhausts its budget)",
		expect: "no-verdict",
		async answer(call, _cmd, ctx) {
			return call === "probe" ? ok() : timedOut(ctx, 15000);
		},
	},
	{
		name: "unanswered (probe exhausts its budget)",
		expect: "no-verdict",
		async answer(call, _cmd, ctx) {
			return call === "probe"
				? timedOut(ctx, 5000)
				: ok(cleanBytes(ctx.fixture));
		},
	},
];

/**
 * A spawn is the runner's work when it names the analysed file or carries the
 * fixture's recorded argv (minus the file) in order, the same tie
 * `captured-real-output.test.ts` asserts. Everything else the runner or its
 * availability checker spawns is a probe.
 */
function isWork(args: string[], fixture: CapturedOutput, ws: string): boolean {
	const fileTokens = new Set([
		fixture.file,
		path.basename(fixture.file),
		fixture.file.replace(/\\/g, "/"),
	]);
	if (
		args.some(
			(token) =>
				fileTokens.has(token) ||
				fileTokens.has(path.relative(ws, token).replace(/\\/g, "/")),
		)
	) {
		return true;
	}
	const recorded = (fixture.provenance.argv ?? [])
		.filter((token) => !fileTokens.has(token))
		.map((token) => token.split(WORKSPACE_TOKEN).join(path.resolve(ws)));
	if (recorded.length === 0) return false;
	let cursor = 0;
	for (const token of args) {
		if (cursor < recorded.length && token === recorded[cursor]) cursor++;
	}
	return cursor === recorded.length;
}

function verdictOf(
	runnerId: string,
	dispatched: DispatchResult,
	outcome: RunnerResult | undefined,
	reachedNoVerdict: (r: RunnerResult) => boolean,
): Verdict {
	// The dispatcher's own rule decides first (a fault arm may carry a synthetic
	// diagnostic and still reached no verdict about the file).
	if (
		outcome === undefined ||
		reachedNoVerdict(outcome) ||
		(dispatched.inconclusiveSources?.runnerIds ?? []).includes(runnerId) ||
		dispatched.unconfirmedStatus !== undefined
	) {
		return "no-verdict";
	}
	if (dispatched.diagnostics.length > 0) return "findings";
	return outcome.status === "succeeded" ? "clean" : "no-verdict";
}

/**
 * Cells whose modelled state is not a state the tool can be in, each with the
 * fact about the tool that says so. A key is `<runner id>/<cell name>`; the
 * guard below fails a key that names no runner or cell.
 */
const NOT_APPLICABLE: Readonly<Record<string, string>> = {
	"cpp-check/wrong version (probe rejected)":
		"MSVC `cl` has no version flag, so the runner probes it with no arguments and accepts any exit status as presence; a rejected-flag answer to an argument-less call is not an answer cl gives",
};

const CAPTURES = listCapturedOutputs();
const RUNNER_IDS = [...new Set(CAPTURES.map((c) => c.provenance.runner))];

describe("tool-state matrix (#4522)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
	});

	it("has captured runners to drive", () => {
		expect(RUNNER_IDS.length).toBeGreaterThan(0);
	});

	it("names only cells that exist among not-applicable states", () => {
		const live = new Set(
			RUNNER_IDS.flatMap((id) => CELLS.map((cell) => `${id}/${cell.name}`)),
		);
		expect(Object.keys(NOT_APPLICABLE).filter((key) => !live.has(key))).toEqual(
			[],
		);
	});

	for (const runnerId of RUNNER_IDS) {
		const fixtures = CAPTURES.filter((c) => c.provenance.runner === runnerId);
		// The non-dirty states need one fixture to name the file and the argv.
		const first = fixtures.find((c) => c.caseName === "real") ?? fixtures[0];

		describe(runnerId, () => {
			for (const cell of CELLS) {
				if (`${runnerId}/${cell.name}` in NOT_APPLICABLE) continue;
				const targets = cell.name === "dirty" ? fixtures : [first];
				for (const fixture of targets) {
					const label =
						cell.name === "dirty"
							? `${cell.name} (${fixture.caseName})`
							: cell.name;
					it(`${label} reads ${cell.expect}`, { timeout: 30000 }, async () => {
						vi.resetModules();
						const dispatcher =
							await import("../../../clients/dispatch/dispatcher.js");
						const { registerDefaultRunners } =
							await import("../../../clients/dispatch/runners/index.js");
						const { FactStore } =
							await import("../../../clients/dispatch/fact-store.js");
						const { reachedNoVerdict } =
							await import("../../../clients/dispatch/types.js");
						const spawn = await import("../../../clients/safe-spawn.js");
						const env = setupTestEnvironment("pi-lens-tool-state-");
						try {
							fs.cpSync(
								path.join(repoRoot, fixture.provenance.workspace),
								env.tmpDir,
								{ recursive: true },
							);
							const filePath = path.join(env.tmpDir, fixture.file);
							const answerCtx: AnswerContext = {
								fixture,
								workspace: env.tmpDir,
								classify: (error, cmd) =>
									spawn.classifySpawnFailure(error, { command: cmd }),
								SpawnFailureError: spawn.SpawnFailureError,
							};
							const spawned: Array<{ call: Call; args: string[] }> = [];
							safeSpawnAsync.mockImplementation(
								async (cmd: string, args: string[]) => {
									const call: Call = isWork(args, fixture, env.tmpDir)
										? "work"
										: "probe";
									spawned.push({ call, args });
									return cell.answer(call, cmd, answerCtx);
								},
							);

							const registry = new dispatcher.RunnerRegistry();
							registerDefaultRunners(registry);
							// `no-lsp` is the user kill switch: without it a CLI runner
							// whose language server is installed on the host skips as
							// covered-by-primary, and the cell would depend on the host.
							const ctx = dispatcher.createDispatchContext(
								filePath,
								env.tmpDir,
								{ getFlag: (flag: string) => flag === "no-lsp" },
								new FactStore(),
								undefined,
								undefined,
								env.tmpDir,
							);
							const outcomes = new Map<string, RunnerResult>();
							const dispatched = await dispatcher.dispatchForFile(
								ctx,
								[{ mode: "all", runnerIds: [runnerId] }],
								registry,
								(id, result) => outcomes.set(id, result),
							);
							const outcome = outcomes.get(runnerId);
							const verdict = verdictOf(
								runnerId,
								dispatched,
								outcome,
								reachedNoVerdict,
							);
							const context = `${runnerId} / ${cell.name}: runner ${outcome?.status}${outcome?.failureKind ? `/${outcome.failureKind}` : ""}${outcome?.skipReason ? `/${outcome.skipReason}` : ""}; spawns ${JSON.stringify(spawned.map((s) => `${s.call}:${s.args.join(" ").slice(0, 60)}`))}`;

							if (cell.expect === "not-clean") {
								expect(
									verdict,
									`${context}: an unanswered tool read clean`,
								).not.toBe("clean");
								return;
							}
							if (cell.expect === "clean" || cell.expect === "findings") {
								// The control: the runner reached its work spawn.
								expect(
									spawned.some((s) => s.call === "work"),
									`${context}: the runner never reached its work spawn, so this cell proves nothing`,
								).toBe(true);
							}
							expect(verdict, context).toBe(cell.expect);
						} finally {
							env.cleanup();
						}
					});
				}
			}
		});
	}
});
