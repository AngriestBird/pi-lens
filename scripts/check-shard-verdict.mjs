#!/usr/bin/env node
// #4672: ONE shard-verdict seam for every sharded required aggregate in
// ci.yml (`TLA+ models` over `tla-shards`, `Unit tests` over `test`).
//
// The defect this replaces: each aggregate ran a `run:` step comparing
// `needs.<job>.result` against the single string `success`, so a shard that
// finished its own work and then lost the race against its own
// `timeout-minutes` was reported `cancelled` and reddened a REQUIRED check on
// master with no model violation and no failing test. Master push run
// 39380875926 (head e3767bd78) is the witness: `TLA+ models (shard 4/4)`
// (job 118491126416) started 06:36:59Z, was `cancelled` at 06:49:14Z -- 735 s
// against a 720 s cap -- and every one of its steps concluded `success`,
// including `Model-check formal/ against each config's expected verdict`
// (06:37:06Z -> 06:49:12Z, 726 s). Three occurrences now: #3591 raised the
// single job's cap 10 -> 20 min as a stopgap, #3918/#3919 sharded it, and
// ci.yml already recorded "PR heads cancelled at 736 s, 881 s and 12m15s".
//
// THE RULE, and why the other direction stays red. A cancelled shard is read
// as a pass-with-warning ONLY when the step that does the shard's work
// concluded `success`: at that point the work that mattered finished, and what
// was cancelled is the job's own teardown (post-steps / the runner reclaiming
// the box). A shard cancelled BEFORE that step finished -- the step is
// `cancelled`, `failed`, or never started -- is a real timeout: its shard's
// configs or tests were not all run, so the aggregate must stay red.
// AGENTS.md "Recurring defect shapes" 11 forbids the opposite reading
// ("absent required checks are not passing checks"): a genuine timeout must
// never read as green, and the harm from a false green here is a model
// violation or a failing test that lands on master.
//
// Evidence that cannot be read is NOT a pass. If the run's job list cannot be
// fetched or parsed, this prints one bounded `fail` line with the reason and
// exits non-zero ("unreadable evidence is not a pass"): the aggregate must
// fail closed, exactly as the raw string comparison it replaces did.
//
// Usage (the aggregate step):
//
//   node scripts/check-shard-verdict.mjs \
//     --label "TLA+ models" \
//     --result "$SHARDS_RESULT" \
//     --shard-pattern '^TLA\+ models \(shard [0-9]+/[0-9]+\)$' \
//     --check-step "Model-check formal/ against each config's expected verdict" \
//     --repository "$GITHUB_REPOSITORY" --run "$GITHUB_RUN_ID"
//
// `--result` is `needs.<shard-job>.result`, the same input the old step read.
// A `success` result short-circuits to `pass` without touching the API, so the
// green path costs nothing. Any other result reads
// `GET /repos/<repository>/actions/runs/<run>/jobs` with the run's own
// `GITHUB_TOKEN` (the aggregate job needs `actions: read` for that) and
// classifies each shard row.
//
// Exit codes: 0 for `pass` and `warn` (the run's work is complete), 1 for
// `fail` (bad argv, unreadable evidence, a real cancellation or a real
// failure).

import fs from "node:fs";
import { parseArgs as parseNodeArgs } from "node:util";
import { githubHeaders } from "./lib/github-rest.mjs";

/** The one step whose conclusion decides whether a cancelled shard finished
 * its work. Accepted as a flag so `tla-shards` and `test` name their own. */
const REQUIRED_FLAGS = ["label", "result", "shard-pattern", "check-step"];

const CLI_OPTIONS = Object.freeze({
	label: { type: "string" },
	result: { type: "string" },
	"shard-pattern": { type: "string" },
	"check-step": { type: "string" },
	repository: { type: "string" },
	run: { type: "string" },
	"jobs-file": { type: "string" },
	"jobs-url": { type: "string" },
});

/**
 * Parse the flags strictly: `node:util` handles the space and the equals form
 * alike (`--run 1` and `--run=1`), and `strict` rejects an unknown flag, a
 * missing value and a positional argument by throwing -- the same reasoning as
 * `scripts/check-tla-models.mjs`'s parser (#3920): a typo must fail loudly,
 * never silently classify with a default.
 */
export function parseArgs(argv) {
	const { values } = parseNodeArgs({
		args: [...argv],
		options: CLI_OPTIONS,
		strict: true,
		allowPositionals: false,
	});
	return { ...values };
}

/** A conclusion that means "this step ran to its end". */
const STEP_DONE = new Set(["success"]);

/**
 * Classify ONE shard job row against the step that does its work.
 *
 * @param {object} job a job object from `GET /actions/runs/<id>/jobs`'s `jobs`
 * @param {string} checkStep the step name whose conclusion vouches for the work
 * @returns {{ outcome: "pass" | "warn" | "fail", reason: string }}
 */
export function classifyShardJob(job, checkStep) {
	const name = String(job?.name ?? "(unnamed job)");
	const conclusion = String(job?.conclusion ?? "");
	const steps = Array.isArray(job?.steps) ? job.steps : [];
	const step = steps.find((entry) => entry?.name === checkStep);
	const stepConclusion =
		step === undefined ? "absent" : String(step.conclusion ?? "in progress");

	if (conclusion === "success") {
		return { outcome: "pass", reason: `${name} succeeded` };
	}
	if (conclusion === "skipped") {
		// The `formal/`-unchanged rule skips the work at STEP level and the job
		// still concludes `success`; a `skipped` job is therefore its own row
		// shape. It ran nothing, so the aggregate cannot read it as a violation
		// (and the aggregate only reaches this branch when its own result was
		// not `success`, which the row-count check below then refuses).
		return { outcome: "pass", reason: `${name} was skipped` };
	}
	if (conclusion === "cancelled") {
		if (step !== undefined && STEP_DONE.has(stepConclusion)) {
			const seconds = stepSeconds(step);
			return {
				outcome: "warn",
				reason: `${name} was cancelled at its own job timeout after \`${checkStep}\` concluded success${seconds === null ? "" : ` (${seconds} s in that step)`}`,
			};
		}
		return {
			outcome: "fail",
			reason: `${name} was cancelled before \`${checkStep}\` finished (step ${step === undefined ? "absent from the job" : `conclusion ${stepConclusion}`})`,
		};
	}
	return {
		outcome: "fail",
		reason: `${name} concluded ${conclusion || "no conclusion"} (every step: ${describeStepConclusions(steps)})`,
	};
}

/** Whole seconds a step ran, or null when GitHub omitted its timestamps. */
function stepSeconds(step) {
	const start = Date.parse(String(step?.started_at ?? ""));
	const end = Date.parse(String(step?.completed_at ?? ""));
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return null;
	return Math.round((end - start) / 1000);
}

/** `success, success, skipped` -- so an unexpected conclusion names its steps. */
function describeStepConclusions(steps) {
	if (steps.length === 0) return "none recorded";
	return steps
		.map((step) => String(step?.conclusion ?? "in progress"))
		.join(", ");
}

/**
 * The aggregate's verdict over every shard row, as `{ outcome, line }`.
 *
 * `result` is `needs.<shard-job>.result`. A `success` result is a pass with no
 * API read at all. Every other result is classified from the rows, and a
 * non-success result that no row explains (every row succeeded, yet the shard
 * job reports `cancelled`) is a FAIL: a matrix cell is missing from the
 * evidence we were given, and shape 11 says an absent row is not a passing
 * one.
 *
 * @param {{ label: string, result: string, shardPattern: RegExp, checkStep: string, jobs: object[] }} args
 */
export function evaluateShardVerdict({
	label,
	result,
	shardPattern,
	checkStep,
	jobs,
}) {
	if (result === "success") {
		return {
			outcome: "pass",
			line: `${label}: every shard job succeeded (needs result success)`,
		};
	}
	const rows = (Array.isArray(jobs) ? jobs : []).filter(
		(job) => job && typeof job.name === "string" && shardPattern.test(job.name),
	);
	if (rows.length === 0) {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result} and no job in the run's job list matched ${shardPattern}; unreadable evidence is not a pass`,
		};
	}
	const classified = rows.map((job) => ({
		job,
		...classifyShardJob(job, checkStep),
	}));
	const failed = classified.filter((entry) => entry.outcome === "fail");
	if (failed.length > 0) {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result}; ${failed.map((entry) => entry.reason).join("; ")}`,
		};
	}
	const warned = classified.filter((entry) => entry.outcome === "warn");
	if (warned.length > 0) {
		return {
			outcome: "warn",
			line: `${label}: needs result ${result}; ${warned.map((entry) => entry.reason).join("; ")}. The step that does this shard's work finished, so the cancellation is a teardown race with the job's own timeout, not a violation; kept as a pass and recorded here`,
		};
	}
	// Every row passed, yet the shard job did not report `success`. That is not
	// a green: at least one shard row is missing from what we can read.
	return {
		outcome: "fail",
		line: `${label}: needs result ${result}; every one of the ${rows.length} shard job(s) in the run's job list succeeded, so a shard row is missing from the evidence; unreadable evidence is not a pass`,
	};
}

/** The jobs URL the aggregate reads. */
export function jobsUrl({ repository, run, jobsUrlOverride }) {
	if (jobsUrlOverride) return jobsUrlOverride;
	if (!repository || !run) return null;
	return `https://api.github.com/repos/${repository}/actions/runs/${run}/jobs`;
}

/**
 * Read the run's job list from `--jobs-file`, else from the API.
 * @returns {Promise<object[]>} the `jobs` array
 */
export async function readJobs({
	jobsFile,
	url,
	token,
	fetchImpl = globalThis.fetch,
	readFileSync = fs.readFileSync,
}) {
	if (jobsFile) {
		const text = String(readFileSync(jobsFile, "utf8"));
		const payload = JSON.parse(text);
		if (!Array.isArray(payload?.jobs)) {
			throw new Error(`${jobsFile} has no jobs array`);
		}
		return payload.jobs;
	}
	if (!url) {
		throw new Error(
			"no --jobs-file, --run or --repository to read the job list from",
		);
	}
	if (!token) {
		throw new Error(`no GITHUB_TOKEN/GH_TOKEN to read ${url}`);
	}
	// The header block is the repo's ONE builder (#4427):
	// `tests/config/github-bearer-ratchet.test.ts` reds on a second spelling.
	const response = await fetchImpl(url, { headers: githubHeaders(token) });
	if (!response?.ok) {
		throw new Error(`GET ${url} -> HTTP ${response?.status ?? "no response"}`);
	}
	const payload = await response.json();
	if (!Array.isArray(payload?.jobs)) {
		throw new Error(`GET ${url} returned no jobs array`);
	}
	return payload.jobs;
}

/**
 * One run of the check, with every boundary injectable so tests never touch
 * the network, the filesystem or the real stdout.
 *
 * @returns {Promise<{ code: number, outcome: string, line: string }>}
 */
export async function runShardVerdict({
	argv = process.argv.slice(2),
	env = process.env,
	stdout = (line) => console.log(line),
	fetchImpl = globalThis.fetch,
	readFileSync = fs.readFileSync,
} = {}) {
	let parsed;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: ${firstLine(error)}`,
			stdout,
		);
	}
	const missing = REQUIRED_FLAGS.filter((flag) => !parsed[flag]);
	if (missing.length > 0) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: missing ${missing.map((flag) => `--${flag}`).join(", ")}; usage: node scripts/check-shard-verdict.mjs --label <name> --result <needs result> --shard-pattern <regexp> --check-step <step name> [--repository <owner/repo> --run <id> | --jobs-file <path>]`,
			stdout,
		);
	}
	let shardPattern;
	try {
		shardPattern = new RegExp(parsed["shard-pattern"]);
	} catch (error) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: --shard-pattern is not a regular expression (${firstLine(error)})`,
			stdout,
		);
	}
	const label = parsed.label;
	if (parsed.result === "success") {
		return emit(
			evaluateShardVerdict({
				label,
				result: parsed.result,
				shardPattern,
				checkStep: parsed["check-step"],
				jobs: [],
			}),
			env,
			stdout,
		);
	}
	let jobs;
	try {
		jobs = await readJobs({
			jobsFile: parsed["jobs-file"],
			url: jobsUrl({
				repository: parsed.repository ?? env.GITHUB_REPOSITORY,
				run: parsed.run ?? env.GITHUB_RUN_ID,
				jobsUrlOverride: parsed["jobs-url"],
			}),
			token: env.GITHUB_TOKEN || env.GH_TOKEN,
			fetchImpl,
			readFileSync,
		});
	} catch (error) {
		// One bounded line. Unreadable evidence is not a pass, and the aggregate
		// must fail closed rather than green-by-accident (shape 11).
		return fail(
			{ code: 1 },
			`${label}: needs result ${parsed.result} and the run's job list could not be read (${firstLine(error).replace(/\s+/g, " ").slice(0, 200)}); unreadable evidence is not a pass`,
			stdout,
			env,
		);
	}
	return emit(
		evaluateShardVerdict({
			label,
			result: parsed.result,
			shardPattern,
			checkStep: parsed["check-step"],
			jobs,
		}),
		env,
		stdout,
	);
}

function emit(verdict, env, stdout) {
	if (verdict.outcome === "fail")
		return fail({ code: 1 }, verdict.line, stdout, env);
	if (verdict.outcome === "warn") {
		stdout(`warn - ${verdict.line}`);
		if (env.GITHUB_ACTIONS === "true") stdout(`::warning::${verdict.line}`);
		return { code: 0, outcome: "warn", line: verdict.line };
	}
	stdout(`pass - ${verdict.line}`);
	return { code: 0, outcome: "pass", line: verdict.line };
}

function fail({ code }, line, stdout, env = process.env) {
	stdout(`fail - ${line}`);
	if (env.GITHUB_ACTIONS === "true") stdout(`::error::${line}`);
	return { code, outcome: "fail", line };
}

function firstLine(error) {
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n")[0];
}

export async function main() {
	const result = await runShardVerdict();
	process.exitCode = result.code;
}

if (process.argv[1] && process.argv[1].endsWith("check-shard-verdict.mjs")) {
	main().catch((error) => {
		console.error(
			`check-shard-verdict failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
