// #4672: the ONE shard-verdict seam both sharded required aggregates use
// (`TLA+ models` over `tla-shards`, `Unit tests` over `test`).
//
// Fixtures under tests/fixtures/ci-shard-verdict/:
//   - tla-cancelled-complete.real.json: the four `TLA+ models (shard k/N)` job
//     rows of master push run 39380875926 attempt 1 (head e3767bd78), plus the
//     `TLA+ models` aggregate row, captured verbatim from
//     `gh api repos/apmantza/pi-lens/actions/runs/39380875926/attempts/1/jobs`
//     (AGENTS.md shape 16: a real external payload, not hand-written). Shard
//     4/4 (job 118491126416) is the witness: started 06:36:59Z, `cancelled` at
//     06:49:14Z -- 735 s against a 720 s `timeout-minutes` -- with every step
//     `success`, the model check itself from 06:37:06Z to 06:49:12Z. Rows for
//     the run's other jobs were dropped from the capture; nothing in them was
//     edited.
//   - tla-cancelled-in-flight.synthetic.json: SYNTHETIC, documented as such.
//     The same payload with shard 4/4's model-check step re-concluded
//     `cancelled`, no `completed_at`, and every later step (and the job's own
//     `completed_at`) truncated away -- what a shard killed DURING its model
//     check looks like. This is the direction that must stay red.
//   - tla-failure.synthetic.json: SYNTHETIC. The same payload with shard 2/4
//     concluding `failure` on its model-check step.
//   - tla-skipped-formal-unchanged.real.json: the four shard rows of run
//     39374931372 attempt 1, captured the same way -- `formal/` was unchanged,
//     so the shard jobs concluded `success` with their model-check step
//     `skipped`. Must stay a pass.
//   - unit-cancelled-complete.synthetic.json: SYNTHETIC, built from a real
//     `Unit tests (shard 1/5)` row of run 39374931372 attempt 1 (the same real
//     step list, names renumbered): shards 1 and 2 `success`, shard 3
//     `cancelled` with `Run tests` concluded `success`, which is #4672's race
//     on the other aggregate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyShardJob,
	evaluateShardVerdict,
	parseArgs,
	readJobs,
	runShardVerdict,
} from "../../scripts/check-shard-verdict.mjs";

const FIXTURES = join(
	import.meta.dirname,
	"..",
	"fixtures",
	"ci-shard-verdict",
);

/** The exact names the two aggregates use in .github/workflows/ci.yml. */
const TLA_PATTERN = /^TLA\+ models \(shard [0-9]+\/[0-9]+\)$/;
const TLA_CHECK_STEP =
	"Model-check formal/ against each config's expected verdict";
const UNIT_PATTERN = /^Unit tests \(shard [0-9]+\/[0-9]+\)$/;
const UNIT_CHECK_STEP = "Run tests";

type ShardJob = {
	id?: number;
	name?: string;
	conclusion?: string | null;
	steps?: Array<{ name?: string; conclusion?: string | null }>;
};

function jobsOf(name: string): ShardJob[] {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))
		.jobs as ShardJob[];
}

/** A verdict line, through the same shape the aggregate step prints. */
function verdictLine(options: {
	label: string;
	result: string;
	pattern: RegExp;
	checkStep: string;
	jobs: ShardJob[];
}) {
	return evaluateShardVerdict({
		label: options.label,
		result: options.result,
		shardPattern: options.pattern,
		checkStep: options.checkStep,
		jobs: options.jobs,
	});
}

describe("#4672 a cancelled shard that finished its work is a pass with a warning", () => {
	// The defect (master run 39380875926): `needs.tla-shards.result` was
	// `cancelled` because shard 4/4 lost the race against its own
	// `timeout-minutes` AFTER its model check concluded `success`. The old
	// aggregate step compared that string against `success` and failed the
	// required `TLA+ models` check on master's tip with no model violation.
	it("keeps the aggregate green for the real cancelled-complete shard, with the warning's reason", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-cancelled-complete.real.json"),
		});
		expect(verdict.outcome).toBe("warn");
		// The reason names the shard and the step that had already finished, so a
		// reader of the aggregate log never has to open the cancelled job.
		expect(verdict.line).toContain("TLA+ models (shard 4/4)");
		expect(verdict.line).toContain("`Model-check");
		expect(verdict.line).toContain("concluded success");
		expect(verdict.line).toContain("726 s");
		expect(verdict.line).not.toContain("violation\n");
	});

	// AGENTS.md shape 11, the direction the fix must NOT bend: a shard killed
	// while its model check was still running ran a fraction of its configs, so
	// its aggregate has to stay red. Reading it as green would let a real model
	// violation land.
	it("stays red for a shard cancelled inside its model-check step", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-cancelled-in-flight.synthetic.json"),
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("TLA+ models (shard 4/4)");
		expect(verdict.line).toContain("cancelled before `Model-check");
		expect(verdict.line).toContain("step conclusion cancelled");
	});

	it("stays red for a genuinely failing shard", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "failure",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-failure.synthetic.json"),
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("TLA+ models (shard 2/4)");
		expect(verdict.line).toContain("concluded failure");
	});

	// The `formal/`-unchanged rule skips the model check at STEP level and the
	// shard job still concludes `success`, so this arrives through the `success`
	// short-circuit. It must stay a pass (a docs-only PR is not a red), and it
	// must not be read as "a cancelled shard".
	it("stays a pass when formal/ was unchanged and the shards skipped their checks", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "success",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-skipped-formal-unchanged.real.json"),
		});
		expect(verdict.outcome).toBe("pass");
		expect(verdict.line).toContain("every shard job succeeded");
		// Classifying the same rows WITHOUT the short-circuit (the aggregate
		// result was not `success`, e.g. a `skipped` matrix) still reads them as
		// passes, never as warnings: their check step is `skipped`, not
		// `success`, so the cancelled-race reading cannot apply.
		const classified = jobsOf("tla-skipped-formal-unchanged.real.json")
			.filter((job) => TLA_PATTERN.test(String(job.name)))
			.map((job) => classifyShardJob(job, TLA_CHECK_STEP).outcome);
		expect(classified).toEqual(["pass", "pass", "pass", "pass"]);
	});

	it("keeps the Unit tests aggregate green for its own cancelled-complete shard", () => {
		const verdict = verdictLine({
			label: "Unit tests",
			result: "cancelled",
			pattern: UNIT_PATTERN,
			checkStep: UNIT_CHECK_STEP,
			jobs: jobsOf("unit-cancelled-complete.synthetic.json"),
		});
		expect(verdict.outcome).toBe("warn");
		expect(verdict.line).toContain("Unit tests (shard 3/5)");
		expect(verdict.line).toContain("`Run tests` concluded success");
	});

	// Unreadable evidence is not a pass: a non-success aggregate result that no
	// row explains means at least one shard row is missing from what we were
	// given (an absent row is not a passing row -- shape 11).
	it("fails closed when every visible shard passed but the aggregate result did not", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json").filter(
			(job) => !String(job.name).includes("shard 4/4"),
		);
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: rows,
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("a shard row is missing from the evidence");
		expect(verdict.line).toContain("unreadable evidence is not a pass");
	});

	it("fails closed when no job in the list matches the shard pattern", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: [{ id: 1, name: "Lint & type-check", conclusion: "success" }],
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("no job in the run's job list matched");
	});

	// The aggregate's own row must never be classified as a shard: the patterns
	// are anchored to `(shard k/N)`, so `TLA+ models` and `Unit tests` alone do
	// not match.
	it("does not read the aggregate row as a shard row", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json");
		expect(
			rows.filter((job) => TLA_PATTERN.test(String(job.name))),
		).toHaveLength(4);
		expect(TLA_PATTERN.test("TLA+ models")).toBe(false);
		expect(UNIT_PATTERN.test("Unit tests")).toBe(false);
	});
});

describe("#4672 the aggregate step's own boundary: argv, fetch failures, annotations", () => {
	const good = jobsOf("tla-cancelled-complete.real.json");

	async function run(argv: string[], options: Record<string, unknown> = {}) {
		const lines: string[] = [];
		const result = await runShardVerdict({
			argv,
			env: {},
			stdout: (line: string) => lines.push(line),
			...options,
		});
		return { ...result, lines };
	}

	const BASE = [
		"--label",
		"TLA+ models",
		"--shard-pattern",
		TLA_PATTERN.source,
		"--check-step",
		TLA_CHECK_STEP,
	];

	it("passes on a `success` result without reading any evidence", async () => {
		let fetched = false;
		const result = await run([...BASE, "--result", "success"], {
			fetchImpl: async () => {
				fetched = true;
				throw new Error("must not fetch on a green run");
			},
		});
		expect(result.code).toBe(0);
		expect(result.outcome).toBe("pass");
		expect(fetched).toBe(false);
		expect(result.lines).toEqual([
			"pass - TLA+ models: every shard job succeeded (needs result success)",
		]);
	});

	it("classifies a cancelled result from a --jobs-file and exits 0 with a warn line", async () => {
		const result = await run([
			...BASE,
			"--result",
			"cancelled",
			"--jobs-file",
			join(FIXTURES, "tla-cancelled-complete.real.json"),
		]);
		expect(result.code).toBe(0);
		expect(result.outcome).toBe("warn");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0].startsWith("warn - ")).toBe(true);
	});

	it("exits 1 with a fail line for the cancelled-in-flight shard", async () => {
		const result = await run([
			...BASE,
			"--result",
			"cancelled",
			"--jobs-file",
			join(FIXTURES, "tla-cancelled-in-flight.synthetic.json"),
		]);
		expect(result.code).toBe(1);
		expect(result.outcome).toBe("fail");
		expect(result.lines[0].startsWith("fail - ")).toBe(true);
	});

	// The aggregate must fail closed when the job list cannot be read: a 403
	// (a job without `actions: read`), a network failure and a malformed body
	// are all "unreadable evidence", never a pass.
	it("fails closed, in one bounded line, when the API refuses the job list", async () => {
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async () => ({ ok: false, status: 403 }),
		});
		expect(result.code).toBe(1);
		expect(result.outcome).toBe("fail");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toContain("HTTP 403");
		expect(result.lines[0]).toContain("unreadable evidence is not a pass");
		expect(result.lines[0].length).toBeLessThan(400);
	});

	it("fails closed when the fetched body has no jobs array", async () => {
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
			}),
		});
		expect(result.code).toBe(1);
		expect(result.lines[0]).toContain("returned no jobs array");
	});

	it("reads the jobs URL it was given, with the run's own token", async () => {
		const seen: Array<{ url: string; headers: unknown }> = [];
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "tok",
			},
			fetchImpl: async (
				url: string,
				init: { headers: Record<string, string> },
			) => {
				seen.push({ url: String(url), headers: init.headers });
				return { ok: true, status: 200, json: async () => ({ jobs: good }) };
			},
		});
		expect(result.outcome).toBe("warn");
		expect(seen[0].url).toBe(
			"https://api.github.com/repos/acme/repo/actions/runs/42/jobs",
		);
		expect(seen[0].headers).toMatchObject({ authorization: "Bearer tok" });
	});

	it("emits the GitHub annotation beside the same line", async () => {
		const result = await run(
			[
				...BASE,
				"--result",
				"cancelled",
				"--jobs-file",
				join(FIXTURES, "tla-cancelled-complete.real.json"),
			],
			{ env: { GITHUB_ACTIONS: "true" } },
		);
		expect(result.lines).toHaveLength(2);
		expect(result.lines[1]).toBe(`::warning::${result.line}`);
	});

	// A typo must never classify a run: an unknown flag, a missing value and a
	// missing required flag all exit non-zero before any read (#3920's rule,
	// applied to this seam).
	it.each([
		[
			"an unknown flag",
			[...BASE, "--result", "cancelled", "--shrad-pattern", "x"],
		],
		["a missing value", ["--label", "TLA+ models", "--result"]],
	])("rejects %s", async (_label, argv) => {
		expect(() => parseArgs(argv as string[])).toThrow();
		const result = await run(argv as string[]);
		expect(result.code).toBe(2);
		expect(result.outcome).toBe("fail");
	});

	it("names every missing required flag", async () => {
		const result = await run(["--result", "cancelled"]);
		expect(result.code).toBe(2);
		expect(result.lines[0]).toContain("--label");
		expect(result.lines[0]).toContain("--shard-pattern");
		expect(result.lines[0]).toContain("--check-step");
	});

	it("rejects a --shard-pattern that is not a regular expression", async () => {
		const result = await run([
			"--label",
			"x",
			"--result",
			"cancelled",
			"--shard-pattern",
			"([",
			"--check-step",
			"y",
		]);
		expect(result.code).toBe(2);
		expect(result.lines[0]).toContain("not a regular expression");
	});

	it("refuses a jobs file with no jobs array", async () => {
		await expect(
			readJobs({
				jobsFile: join(FIXTURES, "..", "not-a-run.json"),
				readFileSync: () => '{"nope":true}',
			}),
		).rejects.toThrow(/has no jobs array/);
	});
});
