// #3700: the orchestrator's hand-rolled CI reads (the `--watch-open` poller,
// the failing-test extraction from job logs, the rerun / update-branch hints,
// post-merge noise, the advisory split, the `--all` snapshot) centralised on
// scripts/ci-verdict.mjs. Every test drives the real CLI entry, `run()`, with
// a `gh` double that replays RECORDED GitHub payloads -- job JSON and job logs
// fetched from apmantza/pi-lens on 2026-09-30 (tests/fixtures/ci-verdict/jobs;
// the logs are excerpts, the elided span marked in the file) -- and no network.
//
// Recurrences this file guards (each test names its own):
//  - #3688 went red in a fix round with nothing notified (--watch-open watched
//    auto-merge PRs only);
//  - a stale `action_required` run pinning a green head at pending (#3697 F2);
//  - the --wait loop caching the push time once (#3697 round-3 verify);
//  - 2026-09-30: a rerun replayed a stale merge commit (#3660) and a
//    post-merge `refs/pull/N/merge` checkout failure was read as a red lane.
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	formatAbsentRequiredReason,
	JOB_LOG_MAX_BUFFER,
	MAX_FAILURE_LINES,
	run,
	WATCH_POLL_INTERVAL_SECONDS,
} from "../../scripts/ci-verdict.mjs";

const FIXTURES = join(process.cwd(), "tests/fixtures");
const JOBS = join(FIXTURES, "ci-verdict/jobs");
const NOW = Date.parse("2026-09-30T12:00:00Z");
const minutesBefore = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

interface Job {
	id: number;
	json: { id: number; name: string; html_url: string };
	log: string;
}
function job(stem: string, logOverride?: string): Job {
	const json = JSON.parse(readFileSync(join(JOBS, `${stem}.json`), "utf8"));
	return {
		id: json.id,
		json,
		log: logOverride ?? readFileSync(join(JOBS, `${stem}.log`), "utf8"),
	};
}
// Recorded jobs: a Unit tests failure in `Run tests` (base 01442e98...), a
// Lint & type-check failure in `Install dependencies`, and an Install test that
// died in checkout on `refs/pull/2623/merge` after PR #2623 merged.
const UNIT_FAIL = () => job("unit-tests-fail-101554674114");
const LINT_INSTALL_FAIL = () => job("lint-install-fail-101496353689");
const POST_MERGE = () => job("checkout-fail-post-merge-101528749222");
const UNIT_FAIL_MERGE_BASE = "01442e987f8c2f88b68d08878027d7148b1b7038";

function row(
	name: string,
	conclusion: string | null,
	id: number,
	detailsUrl?: string,
	status = "completed",
) {
	const url =
		detailsUrl ??
		`https://github.com/apmantza/pi-lens/actions/runs/1/job/${id}`;
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-30T11:00:00Z",
		id,
		html_url: url,
		details_url: url,
	};
}
const jobRow = (j: Job, conclusion = "failure") =>
	row(j.json.name, conclusion, j.id, j.json.html_url);
const GREEN = [
	row("Unit tests", "success", 11),
	row("Lint & type-check", "success", 12),
];

interface PrFixture {
	number: number;
	login?: string;
	sha?: string;
	mergeable?: string;
	autoMerge?: boolean;
	state?: "OPEN" | "MERGED" | "CLOSED";
	checkRuns?: unknown[];
	workflowRuns?: unknown[];
	suites?: { created_at: string }[] | null;
	headReadThrows?: boolean;
}
interface World {
	owner: string;
	viewer: string | null;
	master: string | null;
	prs: PrFixture[];
	jobs: Job[];
	logThrows?: boolean;
	listThrows?: boolean;
	listTransientFailures?: number;
	prStateThrows?: boolean;
	calls: string[];
	logCalls: { args: string[]; options?: Record<string, unknown> }[];
}
const shaOf = (number: number) => String(number).padStart(40, "a");
const sha9 = (number: number) => shaOf(number).slice(0, 9);

function world(partial: Partial<World> & { prs: PrFixture[] }): World {
	return {
		owner: "apmantza",
		viewer: null,
		master: null,
		jobs: [],
		calls: [],
		logCalls: [],
		...partial,
	};
}

/** A `gh` that answers from a mutable World, refusing anything unrecorded. */
function ghFor(w: World) {
	const pr = (n: string) => {
		const found = w.prs.find((p) => String(p.number) === n);
		if (!found) throw new Error(`HTTP 404: no PR ${n}`);
		return found;
	};
	return (
		args: string[],
		options?: { timeoutMs?: number; maxBuffer?: number },
	) => {
		w.calls.push(args.join(" "));
		if (args[0] === "repo") return `${w.owner}/pi-lens`;
		if (args[0] === "pr" && args[1] === "list") {
			if (w.listThrows) throw new Error("HTTP 404: not found");
			if ((w.listTransientFailures ?? 0) > 0) {
				w.listTransientFailures = (w.listTransientFailures ?? 0) - 1;
				throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502" });
			}
			return JSON.stringify(
				w.prs
					.filter((p) => (p.state ?? "OPEN") === "OPEN")
					.map((p) => ({
						number: p.number,
						author: { login: p.login ?? w.owner },
						headRefOid: p.sha ?? shaOf(p.number),
						autoMergeRequest: p.autoMerge ? { enabledAt: "x" } : null,
					})),
			);
		}
		if (args[0] === "pr" && args[1] === "view") {
			const p = pr(args[2]);
			const fields = args[4];
			if (fields === "state") {
				if (w.prStateThrows) throw new Error("HTTP 502");
				return JSON.stringify({ state: p.state ?? "OPEN" });
			}
			if (fields === "autoMergeRequest")
				return JSON.stringify({
					autoMergeRequest: p.autoMerge ? { enabledAt: "x" } : null,
				});
			if (fields === "headRefOid,labels,comments")
				return JSON.stringify({
					headRefOid: p.sha ?? shaOf(p.number),
					labels: [],
					comments: [],
				});
			if (p.headReadThrows) throw new Error("HTTP 404: Not Found");
			return JSON.stringify({
				headRefOid: p.sha ?? shaOf(p.number),
				mergeable: p.mergeable ?? "MERGEABLE",
			});
		}
		if (args[0] === "api" && args[1] === "user") {
			if (w.viewer === null) throw new Error("HTTP 401");
			return JSON.stringify({ login: w.viewer });
		}
		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const bySha = (sha: string) =>
			w.prs.find((p) => (p.sha ?? shaOf(p.number)) === sha);
		if (endpoint.endsWith("/branches/master/protection"))
			throw new Error("HTTP 404: Not Found");
		if (endpoint.endsWith("/branches/master")) {
			if (w.master === null) throw new Error("HTTP 502");
			return JSON.stringify({ commit: { sha: w.master } });
		}
		let m = /\/commits\/([0-9a-f]+)\/check-runs/.exec(endpoint);
		if (m) {
			const runs = bySha(m[1])?.checkRuns ?? [];
			return JSON.stringify({ total_count: runs.length, check_runs: runs });
		}
		m = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(endpoint);
		if (m)
			return JSON.stringify({
				workflow_runs: bySha(m[1])?.workflowRuns ?? [],
			});
		m = /\/commits\/([0-9a-f]+)\/check-suites/.exec(endpoint);
		if (m) {
			const suites = bySha(m[1])?.suites ?? null;
			if (suites === null) throw new Error("HTTP 502");
			return JSON.stringify({
				total_count: suites.length,
				check_suites: suites,
			});
		}
		m = /\/actions\/jobs\/(\d+)\/logs$/.exec(endpoint);
		if (m) {
			w.logCalls.push({ args, options });
			// Production-faithful on the flag under test: without it real gh
			// sanitises the escape sequences the failure lines are wrapped in.
			if (!args.includes("--allow-escape-sequences"))
				throw new Error("log read without --allow-escape-sequences");
			if (w.logThrows) throw new Error("HTTP 410: Gone");
			const found = w.jobs.find((j) => String(j.id) === m?.[1]);
			if (!found) throw new Error("HTTP 404: no such job");
			return found.log;
		}
		m = /\/actions\/jobs\/(\d+)$/.exec(endpoint);
		if (m) {
			const found = w.jobs.find((j) => String(j.id) === m?.[1]);
			if (!found) throw new Error("HTTP 404: no such job");
			return JSON.stringify(found.json);
		}
		throw new Error(`unmocked gh call: ${args.join(" ")}`);
	};
}

function clock(w?: { onSleep?: (index: number) => void }, startMs = NOW) {
	let t = startMs;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => t,
		sleepImpl: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
			w?.onSleep?.(sleeps.length);
		},
	};
}

async function cli(
	argv: string[],
	w: World,
	hooks: { onSleep?: (index: number) => void } = {},
) {
	const time = clock(hooks);
	const lines: string[] = [];
	const errors: string[] = [];
	const exitCode = await run({
		argv,
		ghExec: ghFor(w),
		now: time.now,
		sleepImpl: time.sleepImpl,
		stdout: (line: string) => lines.push(line),
		stderr: (line: string) => errors.push(line),
	});
	return {
		exitCode,
		lines,
		out: lines.join("\n"),
		reason: lines.at(-1) ?? "",
		errors,
		sleeps: time.sleeps,
	};
}

const ESC = String.fromCharCode(27);

describe("run — failing-test extraction from the recorded job log (#3700)", () => {
	// Recurrence: 2026-09-30 the orchestrator read `gh run view --job --log` by
	// hand, stripped the colour codes and grepped ` FAIL ` / `Tests` every time.
	it("names the failed step, the FAIL and assertion lines and the Tests summary, with no ANSI", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Unit tests (job 101554674114): failed step: Run tests",
		);
		expect(out).toContain(
			"  FAIL   default  tests/clients/instance-reaper-backstop.test.ts > #1864 review F2: a grace-spared candidate is re-examined > arms one follow-",
		);
		expect(out).toContain(
			"  AssertionError: expected undefined to be 5 // Object.is equality",
		);
		expect(out).toContain(
			"  Test Files  1 failed | 985 passed | 13 skipped (999)",
		);
		expect(out).toContain(
			"  Tests  1 failed | 13035 passed | 67 skipped (13103)",
		);
		expect(out).not.toContain(ESC);
		// Costs nothing extra: no PR-state read (only a noise candidate needs it).
		expect(w.calls.some((call) => call.includes("--json state"))).toBe(false);
		// vitest prints the assertion twice (`##[error]` repeats it): listed once.
		expect(
			out.match(/AssertionError: expected undefined to be 5/g),
		).toHaveLength(1);
	});

	it("reads the log the way the orchestrator did: gh api --allow-escape-sequences, with a buffer for a megabyte log", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		await cli(["5"], w);
		expect(w.logCalls).toHaveLength(1);
		expect(w.logCalls[0].args).toEqual([
			"api",
			"--allow-escape-sequences",
			"repos/apmantza/pi-lens/actions/jobs/101554674114/logs",
		]);
		expect(w.logCalls[0].options?.maxBuffer).toBe(JOB_LOG_MAX_BUFFER);
		expect(JOB_LOG_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
	});

	it("strips the real ANSI-wrapped FAIL line of a vitest colour log", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			readFileSync(
				join(FIXTURES, "ci-failure-logs/real-assertion-failure.real.log"),
				"utf8",
			),
		);
		expect(unit.log).toContain(`${ESC}[41m`);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out).toContain(
			"  FAIL   default  tests/clients/word-index-lifecycle.test.ts > word-index lifecycle — full mode (#348) > reuses a fresh persisted snapshot without rebuilding",
		);
		expect(out).toContain(
			"  Tests  1 failed | 9837 passed | 48 skipped (9886)",
		);
		expect(out).not.toContain(ESC);
	});

	// Recurrence: a passing test titled "does not FAIL when ..." must not be
	// reported as a failure (the composite log's own trap).
	it("does not report a passing test whose title contains FAIL", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			readFileSync(
				join(
					FIXTURES,
					"ci-failure-logs/fabricated-fail-in-passing-title.composite.log",
				),
				"utf8",
			),
		);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out).not.toContain("does not FAIL");
	});

	it(`caps the listing at ${MAX_FAILURE_LINES} failing lines and counts the rest`, async () => {
		const many = Array.from(
			{ length: MAX_FAILURE_LINES + 5 },
			(_, i) =>
				`2026-09-30T00:00:00.0000000Z  FAIL   default  t${i}.test.ts > case`,
		).join("\n");
		const unit = job("unit-tests-fail-101554674114", many);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out.match(/^ {2}FAIL {3}default/gm)).toHaveLength(MAX_FAILURE_LINES);
		expect(out).toContain("... and 5 more failing lines");
	});

	// Recurrence: "Ast-grep self-scan" / "Audit production dependencies" fail
	// BEFORE the tests run; a reader looking for FAIL lines finds none.
	it("names a failed step that is not the test step, with no invented test lines", async () => {
		const lint = LINT_INSTALL_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [GREEN[0], jobRow(lint)] }],
			jobs: [lint],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Lint & type-check (job 101496353689): failed step: Install dependencies",
		);
		expect(out).not.toContain("Test Files");
		expect(out).not.toMatch(/^ {2}FAIL/m);
	});

	it("keeps the red verdict, with a note, when the job log cannot be read", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			logThrows: true,
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain("could not read the job: HTTP 410: Gone");
	});

	it("says so for a failed check that is not a GitHub Actions job, and reads no log", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						GREEN[0],
						GREEN[1],
						row(
							"Vendor scan",
							"failure",
							77,
							"https://vendor.example/checks/77",
						),
					],
				},
			],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Vendor scan: not a GitHub Actions job: no log to read",
		);
		expect(w.logCalls).toHaveLength(0);
		// No merge base was found, so master's head is not read either.
		expect(w.calls.some((call) => call.endsWith("/branches/master"))).toBe(
			false,
		);
	});

	it("reads no job or log for a green head", async () => {
		const w = world({ prs: [{ number: 5, checkRuns: GREEN }] });
		const { exitCode } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(w.calls.some((call) => call.includes("/actions/jobs/"))).toBe(false);
	});
});

describe("run — gating and advisory reported apart (#3700)", () => {
	// Recurrence: 2026-09-07 a loop text-matched `failure` in the table and
	// stopped on a green PR whose only red was an advisory row.
	it("lists advisory reds on their own line and never lets them fail the verdict", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						...GREEN,
						row("mutation (advisory)", "failure", 21),
						row("OSV scan (advisory)", "timed_out", 22),
						row("PR body (advisory)", "success", 23),
					],
				},
			],
		});
		const { exitCode, lines } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines).toContain("Gating: 2 checks, 0 failing");
		expect(lines).toContain(
			"Advisory (never gates): 3 checks, 2 red: OSV scan (advisory) (timed_out), mutation (advisory) (failure)",
		);
	});

	it("keeps a gating red out of the advisory line and an advisory red out of the gating line", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						row("Unit tests", "failure", 11),
						GREEN[1],
						row("mutation (advisory)", "failure", 21),
					],
				},
			],
		});
		const { exitCode, lines } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(lines).toContain(
			"Gating: 2 checks, 1 failing: Unit tests (failure)",
		);
		expect(lines).toContain(
			"Advisory (never gates): 1 checks, 1 red: mutation (advisory) (failure)",
		);
	});
});

describe("run — rerun and update-branch remedies (#3700)", () => {
	// Recurrence (#3660, 2026-09-30): `gh run rerun` replays the ORIGINAL merge
	// commit, so a lane red on a base master has since moved past reds again.
	it("hints gh pr update-branch when the failed merge's base is no longer master", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
		});
		const { out } = await cli(["3688"], w);
		expect(out).toContain(
			`hint: master moved since this failure's merge base (${UNIT_FAIL_MERGE_BASE.slice(0, 9)} -> bbbbbbbbb): gh run rerun replays the old merge commit and cannot pick up what master gained -- use gh pr update-branch 3688`,
		);
	});

	it("gives no update-branch hint when the merge base is still master's head", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: UNIT_FAIL_MERGE_BASE,
		});
		const { exitCode, out } = await cli(["3688"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	it("gives no update-branch hint when master's head cannot be read", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: null,
		});
		const { exitCode, out } = await cli(["3688"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	it("gives no update-branch hint for a bare-SHA target (no PR to update)", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
		});
		const { exitCode, out } = await cli([shaOf(3688)], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	// Confirmed and pinned (2026-09-30, "superseded run cancelled and not
	// replaced"): the exact rerun command, from the recorded #3382 check-runs.
	it("prints the exact gh run rerun command for a cancelled run that was not replaced", async () => {
		const cancelled = JSON.parse(
			readFileSync(join(FIXTURES, "ci-verdict/pr-3382-cancelled.json"), "utf8"),
		);
		const w = world({
			prs: [
				{
					number: 3382,
					sha: cancelled.source.head,
					checkRuns: [
						row("Unit tests", "success", 11),
						...cancelled.check_runs,
					],
				},
			],
		});
		const { exitCode, reason } = await cli(["3382"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(reason).toBe(
			"superseded run cancelled and not replaced: rerun 36022234159 (gh run rerun 36022234159)",
		);
	});
});

describe("run — post-merge noise is not a failure (#3700)", () => {
	// Recurrence: a PR's checkout job re-run after the merge cannot fetch
	// `refs/pull/N/merge` (the ref is gone); the red row was read as a real one.
	const noisy = () => {
		const j = POST_MERGE();
		return { j, rows: [...GREEN, jobRow(j)] };
	};

	it("reports a checkout that could not fetch refs/pull/N/merge on a MERGED PR as noise, exit 0", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode, out, reason } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(reason).toContain("post-merge noise, not a failure");
		expect(reason).toContain("Install test (macos-latest)");
		expect(out).toContain("Gating: 3 checks, 0 failing");
	});

	it("keeps the same red a FAILURE while the PR is open (there it means a conflicted PR)", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "OPEN", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode, reason } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(reason).toContain("Install test (macos-latest) (failure)");
	});

	it("keeps it a failure when the PR state cannot be read", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [j],
			prStateThrows: true,
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	// Recurrence (review r1, F1): the excuse fired on ANY log line quoting the
	// ref text, so a MERGED PR whose Unit tests really failed (and whose output
	// happens to contain the text) read as exit 0 "post-merge noise".
	it("keeps a MERGED PR's real test failure a failure when the same log also quotes the missing merge ref", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			`${readFileSync(join(JOBS, "unit-tests-fail-101554674114.log"), "utf8")}\n2026-09-06T20:44:10.0300000Z fatal: couldn't find remote ref refs/pull/5/merge\n`,
		);
		const w = world({
			prs: [
				{
					number: 5,
					state: "MERGED",
					checkRuns: [jobRow(unit), GREEN[1]],
				},
			],
			jobs: [unit],
		});
		const { exitCode, out, reason } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(reason).not.toContain("post-merge noise");
		expect(out).toContain("Gating: 2 checks, 1 failing: Unit tests (failure)");
	});

	it("keeps it a failure when the ref that could not be fetched is another PR's", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2624, state: "MERGED", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode } = await cli(["2624"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("keeps it a failure when the failed step is not the checkout", async () => {
		const lint = job(
			"lint-install-fail-101496353689",
			readFileSync(
				join(JOBS, "checkout-fail-post-merge-101528749222.log"),
				"utf8",
			),
		);
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [GREEN[0], jobRow(lint)],
				},
			],
			jobs: [lint],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("keeps it a failure when the job names no failed step at all", async () => {
		const { j, rows } = noisy();
		const bare = { ...j, json: { ...j.json, steps: [] } };
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [bare],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("drops only the noise row when a real failure sits beside it", async () => {
		const { j } = noisy();
		const unit = UNIT_FAIL();
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [jobRow(unit), GREEN[1], jobRow(j)],
				},
			],
			jobs: [j, unit],
		});
		const { exitCode, lines } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(lines).toContain(
			"Gating: 3 checks, 1 failing: Unit tests (failure)",
		);
	});

	it("does not turn a still-running check into a pass when noise is dropped", async () => {
		const { j } = noisy();
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [
						row("Unit tests", null, 11, undefined, "in_progress"),
						GREEN[1],
						jobRow(j),
					],
				},
			],
			jobs: [j],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_PENDING);
	});
});

describe("run --all — one line per open PR (#3700)", () => {
	it("prints author, auto-merge, head, state and the first failing check for every open PR", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [
				{
					number: 10,
					login: "apmantza",
					autoMerge: true,
					checkRuns: [jobRow(unit), GREEN[1]],
				},
				{ number: 11, login: "stranger", checkRuns: GREEN },
				{ number: 12, login: "stranger", checkRuns: [], workflowRuns: [] },
				{ number: 13, login: "stranger", headReadThrows: true },
				{ number: 14, login: "stranger", state: "MERGED" },
				{
					number: 15,
					login: "stranger",
					checkRuns: [GREEN[0], row("Lint & type-check", "cancelled", 12)],
				},
				{
					number: 16,
					login: "stranger",
					mergeable: "CONFLICTING",
					checkRuns: GREEN,
				},
			],
			jobs: [unit],
		});
		const { exitCode, lines } = await cli(["--all"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines).toEqual([
			`#10 apmantza auto-merge=on head=${sha9(10)} gating=failed first-failure=Unit tests`,
			`#11 stranger auto-merge=off head=${sha9(11)} gating=success`,
			`#12 stranger auto-merge=off head=${sha9(12)} gating=pending`,
			`#13 stranger auto-merge=off head=${sha9(13)} gating=unreadable`,
			`#15 stranger auto-merge=off head=${sha9(15)} gating=cancelled`,
			`#16 stranger auto-merge=off head=${sha9(16)} gating=dirty`,
		]);
	});
});

describe("run --watch-open — every PR the maintainer or orchestrator owns (#3700)", () => {
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const stateFile = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-watch-"));
		dirs.push(dir);
		return join(dir, "state.json");
	};
	const failedRuns = () => {
		const unit = UNIT_FAIL();
		return { unit, runs: [jobRow(unit), GREEN[1]] };
	};

	// Recurrence: #3688 sat red in a fix round (no auto-merge armed) and the
	// watcher, which listed auto-merge PRs only, said nothing.
	it("reports a red PR of the maintainer that has no auto-merge, as `#<pr> <event> @<sha>: <reason>` plus the failure detail", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode, lines } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines[0]).toBe(
			`#3688 failed @${sha9(3688)}: gating check(s) completed with a non-success conclusion: Unit tests (failure)`,
		);
		expect(lines).toContain(
			"  Unit tests (job 101554674114): failed step: Run tests",
		);
		expect(lines.some((line) => line.startsWith("    Tests  1 failed"))).toBe(
			true,
		);
	});

	it("does not watch a stranger's PR without auto-merge, and never reads it", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 40, login: "stranger", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode, out } = await cli(["--watch-open", "--wait", "0"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(w.calls.some((call) => call.startsWith("pr view 40"))).toBe(false);
	});

	it("watches a stranger's PR once auto-merge is armed", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [
				{ number: 40, login: "stranger", autoMerge: true, checkRuns: runs },
			],
			jobs: [unit],
		});
		const { exitCode, lines } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines[0]).toContain("#40 failed");
	});

	it("watches a PR authored by the gh viewer (the orchestrator account)", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 41, login: "orchestrator-bot", checkRuns: runs }],
			jobs: [unit],
			viewer: "orchestrator-bot",
		});
		const { lines } = await cli(["--watch-open"], w);
		expect(lines[0]).toContain("#41 failed");
	});

	it("reports a PR that turns red between polls on that transition, not before", async () => {
		const { unit, runs } = failedRuns();
		const pr: PrFixture = {
			number: 3688,
			login: "apmantza",
			checkRuns: [
				row("Unit tests", null, 11, undefined, "in_progress"),
				GREEN[1],
			],
		};
		const w = world({ prs: [pr], jobs: [unit] });
		const { exitCode, lines, sleeps } = await cli(["--watch-open"], w, {
			onSleep: () => {
				pr.checkRuns = runs;
			},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(sleeps).toEqual([WATCH_POLL_INTERVAL_SECONDS * 1000]);
		expect(lines[0]).toContain("#3688 failed");
	});

	it("does not report the same failure on the same head again after a re-arm (state file)", async () => {
		const { unit, runs } = failedRuns();
		const file = stateFile();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const first = await cli(["--watch-open", "--state-file", file], w);
		expect(first.lines[0]).toContain("#3688 failed");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			"3688": `${shaOf(3688)}:failed`,
		});
		const second = await cli(
			["--watch-open", "--wait", "0", "--state-file", file],
			w,
		);
		expect(second.exitCode).toBe(EXIT_PENDING);
		expect(second.out).toBe("watch window elapsed with no event");
	});

	it("reports the failure again for a new head, and again after a rerun passes through pending", async () => {
		const { unit, runs } = failedRuns();
		const file = stateFile();
		writeFileSync(file, JSON.stringify({ "3688": `${"c".repeat(40)}:failed` }));
		const pr: PrFixture = { number: 3688, login: "apmantza", checkRuns: runs };
		const w = world({ prs: [pr], jobs: [unit] });
		// New head (aaaa... vs the recorded cccc...) with the same kind: an event.
		const newHead = await cli(["--watch-open", "--state-file", file], w);
		expect(newHead.lines[0]).toContain("#3688 failed");
		// Same head, failed -> pending (a rerun) -> failed: the return is an event.
		pr.checkRuns = [row("Unit tests", null, 11, undefined, "queued"), GREEN[1]];
		const again = await cli(["--watch-open", "--state-file", file], w, {
			onSleep: () => {
				pr.checkRuns = runs;
			},
		});
		expect(again.exitCode).toBe(EXIT_SUCCESS);
		expect(again.sleeps).toHaveLength(1);
		expect(again.lines[0]).toContain("#3688 failed");
	});

	it("reports a merged and a closed PR once, and forgets one that merely left the watch set", async () => {
		const file = stateFile();
		writeFileSync(
			file,
			JSON.stringify({
				"7": `${shaOf(7)}:pending`,
				"8": `${shaOf(8)}:pending`,
				"9": `${shaOf(9)}:pending`,
			}),
		);
		const w = world({
			prs: [
				{ number: 7, state: "MERGED" },
				{ number: 8, state: "CLOSED" },
				{ number: 9, login: "stranger", checkRuns: GREEN },
			],
		});
		const { exitCode, lines } = await cli(
			["--watch-open", "--state-file", file],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines).toEqual(["#7 merged", "#8 closed"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
	});

	// Recurrence (#3697 F2): a stale action_required run must never pin a green
	// head at pending, and must not raise an approval event on one.
	it("raises no event for a green head that still lists stale action_required runs", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					login: "apmantza",
					checkRuns: GREEN,
					workflowRuns: [
						{
							id: 36566476498,
							name: "CI",
							head_sha: shaOf(3443),
							status: "completed",
							conclusion: "action_required",
						},
					],
				},
			],
		});
		const { exitCode, out } = await cli(["--watch-open", "--wait", "0"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
	});

	it("reports fork approval awaited, with the approve command", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [
						{
							id: 36566476498,
							name: "CI",
							head_sha: shaOf(3443),
							status: "completed",
							conclusion: "action_required",
						},
					],
				},
			],
		});
		const { lines } = await cli(["--watch-open"], w);
		expect(lines[0]).toBe(
			`#3443 fork-approval @${sha9(3443)}: awaiting fork approval (maintainer decision, never automatic): gh api -X POST repos/apmantza/pi-lens/actions/runs/36566476498/approve`,
		);
	});

	it("reports required checks absent past the threshold on an armed PR, and not before it", async () => {
		const pr: PrFixture = {
			number: 3679,
			login: "stranger",
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [{ created_at: minutesBefore(45) }],
		};
		const old = await cli(["--watch-open"], world({ prs: [pr] }));
		expect(old.lines[0]).toBe(
			`#3679 absent-rearm @${sha9(3679)}: ${formatAbsentRequiredReason(shaOf(3679), 45)}`,
		);
		pr.suites = [{ created_at: minutesBefore(2) }];
		const fresh = await cli(
			["--watch-open", "--wait", "0"],
			world({ prs: [pr] }),
		);
		expect(fresh.exitCode).toBe(EXIT_PENDING);
		expect(fresh.out).toBe("watch window elapsed with no event");
	});

	it("keeps polling every 90 s until the window ends, then says nothing happened", async () => {
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: GREEN }],
		});
		const { exitCode, out, sleeps } = await cli(
			["--watch-open", "--wait", "300"],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(sleeps).toEqual([90_000, 90_000, 90_000, 30_000]);
	});

	it("skips a PR whose read failed instead of dying or inventing an event", async () => {
		const w = world({
			prs: [
				{ number: 50, login: "apmantza", headReadThrows: true },
				{ number: 51, login: "apmantza", checkRuns: GREEN },
			],
		});
		const { exitCode, out, errors } = await cli(
			["--watch-open", "--wait", "0"],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(errors.join("\n")).toContain("HTTP 404");
	});

	// Recurrence (#2935): two GitHub outages killed seven armed waits at once; a
	// watch armed for 20 minutes must ride out a 502 on its list read too.
	it("waits out a transient error on the open-PR list read instead of exiting 70", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
			listTransientFailures: 1,
		});
		const { exitCode, lines, errors, sleeps } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(sleeps).toEqual([30_000]);
		expect(errors.join("\n")).toContain("transient gh error, retrying in 30s");
		expect(lines[0]).toContain("#3688 failed");
	});

	it("starts empty from a corrupt or non-object state file, and rewrites it as an object", async () => {
		const { unit, runs } = failedRuns();
		for (const content of ["not json", "null", '["3688"]']) {
			const file = stateFile();
			writeFileSync(file, content);
			const w = world({
				prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
				jobs: [unit],
			});
			const { exitCode, lines } = await cli(
				["--watch-open", "--state-file", file],
				w,
			);
			expect(exitCode).toBe(EXIT_SUCCESS);
			expect(lines[0]).toContain("#3688 failed");
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
				"3688": `${shaOf(3688)}:failed`,
			});
		}
	});

	// Recurrence (review r1, F2): a merge-conflicted armed PR (its gates are
	// skipped, AGENTS.md shape 11) sat silent for the whole window.
	it("reports a merge-conflicted armed PR once per head", async () => {
		const file = stateFile();
		const w = world({
			prs: [
				{
					number: 6,
					login: "stranger",
					autoMerge: true,
					mergeable: "CONFLICTING",
					checkRuns: [],
				},
			],
		});
		const first = await cli(["--watch-open", "--state-file", file], w);
		expect(first.exitCode).toBe(EXIT_SUCCESS);
		expect(first.lines[0]).toContain(
			`#6 dirty @${sha9(6)}: one or more required checks are absent and the PR is merge-conflicted (mergeable=CONFLICTING)`,
		);
		const again = await cli(
			["--watch-open", "--wait", "0", "--state-file", file],
			w,
		);
		expect(again.exitCode).toBe(EXIT_PENDING);
	});

	it("reaches absent-rearm for an armed PR whose head has no check suite, measured from when the watch first saw it", async () => {
		const w = world({
			prs: [
				{
					number: 3679,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [],
					suites: [],
				},
			],
		});
		const { exitCode, lines, sleeps } = await cli(
			["--watch-open", "--wait", "900"],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines[0]).toBe(
			`#3679 absent-rearm @${sha9(3679)}: ${formatAbsentRequiredReason(shaOf(3679), 10)}`,
		);
		// 7 sleeps of 90 s = 630 s: the first poll at which 10 whole minutes passed.
		expect(sleeps).toHaveLength(7);
	});

	it("reaches the re-arm text under --wait for a head with no check suite, and stays quiet on a one-shot read", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [],
		};
		const waited = await cli(["3679", "--wait", "1200"], world({ prs: [pr] }));
		expect(waited.reason).toBe(formatAbsentRequiredReason(shaOf(3679), 20));
		const once = await cli(["3679"], world({ prs: [pr] }));
		expect(once.reason).toContain("CI likely hasn't registered yet");
	});

	// Recurrence (review r1, F3): a truncated state file reads as empty, so
	// every PR reported again; a bad path lost the poll's own report.
	it("writes the state file atomically into a directory it creates", async () => {
		const { unit, runs } = failedRuns();
		const dir = join(dirname(stateFile()), "nested", "deeper");
		const file = join(dir, "state.json");
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		await cli(["--watch-open", "--state-file", file], w);
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			"3688": `${shaOf(3688)}:failed`,
		});
	});

	it("prints the events before it persists the state, and keeps them when the state cannot be saved", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const file = stateFile();
		const seenOnFirstLine: boolean[] = [];
		const time = clock();
		const errors: string[] = [];
		const exitCode = await run({
			argv: ["--watch-open", "--state-file", file],
			ghExec: ghFor(w),
			now: time.now,
			sleepImpl: time.sleepImpl,
			stdout: () => seenOnFirstLine.push(existsSync(file)),
			stderr: (line: string) => errors.push(line),
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(seenOnFirstLine.length).toBeGreaterThan(0);
		expect(seenOnFirstLine.every((exists) => !exists)).toBe(true);
		expect(existsSync(file)).toBe(true);
		// A path whose parent is a regular file cannot be written at all.
		const bad = await cli(
			["--watch-open", "--state-file", join(file, "x.json")],
			w,
		);
		expect(bad.exitCode).toBe(EXIT_SUCCESS);
		expect(bad.lines[0]).toContain("#3688 failed");
		expect(bad.errors.join("\n")).toContain("could not save the watch state");
	});

	it("exits 70, not a verdict code, when the open-PR list cannot be read", async () => {
		const w = world({ prs: [], listThrows: true });
		const { exitCode, errors } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(errors.join("\n")).toContain("HTTP 404");
	});
});

describe("run --wait — the head's push time and auto-merge are re-read (#3700, the #3697 round-3 verify)", () => {
	// Recurrence: probed `--wait 1200` with no check suite on poll 1: the whole
	// window stayed on the quiet text because the push time was cached once.
	const absent = { checkRuns: [], workflowRuns: [] };
	const reArm = formatAbsentRequiredReason(shaOf(3679), 45);
	const suiteCalls = (w: World) =>
		w.calls.filter((call) => call.includes("/check-suites")).length;

	it("re-reads the check suites while none exists, so a suite that appears later arms the message", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			...absent,
			suites: [],
		};
		const w = world({ prs: [pr] });
		const { exitCode, reason } = await cli(["3679", "--wait", "30"], w, {
			onSleep: () => {
				pr.suites = [{ created_at: minutesBefore(45) }];
			},
		});
		expect(exitCode).toBe(EXIT_PENDING);
		expect(reason).toBe(reArm);
	});

	it("re-reads the auto-merge state every poll, so arming mid-wait changes the message", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: false,
			...absent,
			suites: [{ created_at: minutesBefore(45) }],
		};
		const w = world({ prs: [pr] });
		const { reason } = await cli(["3679", "--wait", "30"], w, {
			onSleep: () => {
				pr.autoMerge = true;
			},
		});
		expect(reason).toBe(reArm);
	});

	it("reads the check suites once the push time is known, not every poll", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			...absent,
			suites: [{ created_at: minutesBefore(45) }],
		};
		const w = world({ prs: [pr] });
		const { sleeps } = await cli(["3679", "--wait", "120"], w);
		expect(sleeps.length).toBeGreaterThanOrEqual(3);
		expect(suiteCalls(w)).toBe(1);
	});

	it("keeps re-reading while the suites stay empty or unreadable", async () => {
		for (const suites of [[], null]) {
			const w = world({
				prs: [{ number: 3679, autoMerge: true, ...absent, suites }],
			});
			const { sleeps } = await cli(["3679", "--wait", "120"], w);
			expect(suiteCalls(w)).toBe(sleeps.length + 1);
		}
	});
});
