// #3920 item 3: a required job's recent runtime against its `timeout-minutes`.
//
// The TLA+ shard cap was only found when pull requests started timing out
// (623-881 s against a 720 s cap), and #4672 then showed the sharper half: a
// 735 s shard was `cancelled` at its own 720 s timeout and reddened a REQUIRED
// check with no model violation. Nothing compared a job's runtime to its cap.
//
// The caps come from the workflow YAML the runner enforces (one source, no
// second table), and the durations come from the check-runs `ci-verdict`
// already fetched (`started_at`/`completed_at` on every row), so the report
// costs no network call of its own. It is non-gating: it never touches the
// exit code.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	checkNamePattern,
	computeVerdict,
	formatRuntimeCapLines,
	jobCapEntries,
	MAX_RUNTIME_CAP_LINES,
	readJobTimeCaps,
	RUNTIME_CAP_WARN_RATIO,
	runtimeCapLines,
} from "../../scripts/ci-verdict.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

/** The four `TLA+ models (shard k/N)` rows of run 39380875926 attempt 1,
 * captured verbatim (see tests/fixtures/ci-shard-verdict/). */
function realShardRows() {
	const payload = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"..",
				"fixtures",
				"ci-shard-verdict",
				"tla-cancelled-complete.real.json",
			),
			"utf8",
		),
	) as {
		jobs: Array<{ name: string; started_at: string; completed_at: string }>;
	};
	return payload.jobs.map((job) => ({
		name: job.name,
		started_at: job.started_at,
		completed_at: job.completed_at,
		status: "completed",
		conclusion: "success",
	}));
}

describe("#3920 item 3: a required job's runtime against its cap", () => {
	// The finding the issue asked for: with the cap that shipped, this report
	// names the shard at 102% of its cap BEFORE it loses its teardown race.
	it("names the real 735 s shard at 102% of the 12-minute cap it shipped with", () => {
		const caps = [
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-shards",
				name: "TLA+ models (shard ...)",
				capMinutes: 12,
				pattern: checkNamePattern(
					"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
				),
			},
		];
		const lines = runtimeCapLines({ checkRuns: realShardRows(), caps });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("TLA+ models (shard 4/4)");
		// 06:36:59Z -> 06:49:14Z is 735 s against 720 s.
		expect(lines[0]).toContain("735s of 720s (102%)");
		expect(lines[0]).toContain("at or over its cap");
		expect(lines[0]).toContain("#4672");
	});

	// The size decision this PR made, pinned as behaviour: at the new 20-minute
	// cap the measured shard is at 61%, under the 70% warning line. A regression
	// that silently re-tightens the cap shows up here.
	it("is quiet at the cap this PR measured (20 min, 61% of it)", async () => {
		const caps = await readJobTimeCaps(ROOT);
		const lines = runtimeCapLines({ checkRuns: realShardRows(), caps });
		expect(lines).toHaveLength(1);
		// Four shard rows plus the aggregate row: every one resolves to a cap and
		// every one is under the warning line at 20 min / 30 min.
		expect(lines[0]).toMatch(
			/no job is at 70% of its timeout \(5 job\(s\) measured\)/,
		);
	});

	// A matrix shard is its own subject: the aggregate's own row is seconds of
	// `echo`, and the shard that gets cancelled is the one worth naming.
	it("warns about one shard alone while its aggregate stays far below its cap", () => {
		const caps = [
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-shards",
				name: "shard",
				capMinutes: 12,
				pattern: checkNamePattern(
					"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
				),
			},
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-models",
				name: "aggregate",
				capMinutes: 10,
				pattern: checkNamePattern("TLA+ models"),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				{
					name: "TLA+ models (shard 4/4)",
					started_at: "2026-10-20T06:36:59Z",
					completed_at: "2026-10-20T06:46:14Z", // 555 s of 720 s = 77%
				},
				{
					name: "TLA+ models",
					started_at: "2026-10-20T06:49:16Z",
					completed_at: "2026-10-20T06:49:19Z", // 3 s of 600 s
				},
			],
			caps,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("TLA+ models (shard 4/4)");
		expect(lines[0]).toContain("(77%)");
		expect(lines[0]).toContain("within 30% of its cap");
	});

	it("uses the 70% threshold and the latest run of a name", () => {
		expect(RUNTIME_CAP_WARN_RATIO).toBe(0.7);
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 10,
				pattern: checkNamePattern("Job"),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				// an older, slower run of the same name must lose to the newer one
				{
					name: "Job",
					id: 1,
					started_at: "2026-10-20T06:00:00Z",
					completed_at: "2026-10-20T06:09:00Z",
				},
				{
					name: "Job",
					id: 2,
					started_at: "2026-10-20T07:00:00Z",
					completed_at: "2026-10-20T07:01:00Z",
				},
			],
			caps,
		});
		expect(lines[0]).toContain("no job is at 70%");
	});

	it("skips a run with no usable duration instead of guessing one", () => {
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 1,
				pattern: checkNamePattern("Job"),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [{ name: "Job", started_at: "2026-10-20T07:00:00Z" }],
			caps,
		});
		expect(lines[0]).toContain("(0 job(s) measured)");
	});

	it("discloses the jobs it does not print", () => {
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 1,
				pattern: /^Job [0-9]+$/,
			},
		];
		const checkRuns = Array.from(
			{ length: MAX_RUNTIME_CAP_LINES + 3 },
			(_, index) => ({
				name: `Job ${index}`,
				started_at: "2026-10-20T07:00:00Z",
				completed_at: "2026-10-20T07:00:59Z",
			}),
		);
		const lines = runtimeCapLines({
			checkRuns,
			caps,
			limit: MAX_RUNTIME_CAP_LINES,
		});
		expect(lines).toHaveLength(MAX_RUNTIME_CAP_LINES + 1);
		expect(lines.at(-1)).toContain("+3 more job(s)");
	});

	it("fails open into one bounded line when the workflow tree is unreadable", async () => {
		const lines = await formatRuntimeCapLines({
			checkRuns: realShardRows(),
			root: join(ROOT, "no-such-checkout"),
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Runtime vs cap: unavailable");
	});

	// Non-gating, proven through the real verdict function: the report is a
	// separate read of the same payload and never enters the exit code.
	it("does not change the verdict for an over-cap job", async () => {
		const payload = {
			check_runs: [
				{
					name: "TLA+ models (shard 4/4)",
					status: "completed",
					conclusion: "success",
					started_at: "2026-10-20T06:36:59Z",
					completed_at: "2026-10-20T06:49:14Z",
				},
			],
		};
		const verdict = computeVerdict(payload, ["TLA+ models (shard 4/4)"]);
		const caps = await readJobTimeCaps(ROOT);
		const lines = runtimeCapLines({ checkRuns: payload.check_runs, caps });
		expect(verdict.exitCode).toBe(0);
		expect(lines.length).toBeGreaterThan(0);
	});
});

describe("#3920 item 3: the caps come from the workflow YAML itself", () => {
	it("resolves a matrix job's cap from its expanded check-run name", async () => {
		const caps = await readJobTimeCaps(ROOT);
		const shard = caps.filter((entry) =>
			entry.pattern.test("TLA+ models (shard 4/4)"),
		);
		expect(shard.map((entry) => entry.jobId)).toEqual(["tla-shards"]);
		expect(shard[0].capMinutes).toBe(20);
		// The aggregate keeps its own cap; the two rows must not swallow each
		// other's names.
		expect(
			caps
				.filter((entry) => entry.pattern.test("TLA+ models"))
				.map((entry) => entry.jobId),
		).toEqual(["tla-models"]);
		const unit = caps.filter((entry) =>
			entry.pattern.test("Unit tests (shard 3/5)"),
		);
		expect(unit.map((entry) => entry.jobId)).toEqual(["test"]);
	});

	it("reads every workflow that declares a timeout, including lint.yml", async () => {
		const caps = await readJobTimeCaps(ROOT);
		expect(caps.map((entry) => entry.file)).toContain(
			".github/workflows/lint.yml",
		);
		expect(caps.length).toBeGreaterThan(50);
	});

	it("expands only strategy.job-total to a number; any other expression admits one token", () => {
		const total = checkNamePattern(
			"Join (${{ matrix.os }}/${{ strategy.job-total }})",
		);
		expect(total.test("Join (ubuntu-latest/4)")).toBe(true);
		expect(total.test("Join (ubuntu-latest/x)")).toBe(false);
		const any = checkNamePattern("Job (${{ github.ref }})");
		expect(any.test("Job (refs/heads/master)")).toBe(true);
		// Anchored: a longer name is a different check.
		expect(any.test("Job (refs/heads/master) extra")).toBe(false);
	});

	it("keeps a job id as the name when the job declares none", () => {
		const entries = jobCapEntries(
			{ jobs: { build: { "timeout-minutes": 5 }, other: {} } },
			"ci.yml",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			jobId: "build",
			name: "build",
			capMinutes: 5,
			file: "ci.yml",
		});
		expect(entries[0].pattern.test("build")).toBe(true);
	});

	it("ignores a job with no cap and one with an unreadable cap", () => {
		expect(
			jobCapEntries(
				{
					jobs: {
						a: {},
						b: { "timeout-minutes": "soon" },
						c: { "timeout-minutes": 0 },
					},
				},
				"ci.yml",
			),
		).toEqual([]);
	});

	it("parses what js-yaml sees in the real ci.yml, not a copy of it", async () => {
		const doc = yaml.load(
			readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
		) as { jobs: Record<string, { "timeout-minutes"?: number }> };
		const entries = jobCapEntries(doc, "ci.yml");
		const shard = entries.find((entry) => entry.jobId === "tla-shards");
		expect(shard?.capMinutes).toBe(doc.jobs["tla-shards"]["timeout-minutes"]);
		expect(doc.jobs["tla-shards"]["timeout-minutes"]).toBe(20);
	});
});
