import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
	formatP90Warning,
	p90,
	P90_CAP_RATIO,
	p90Warnings,
	requiredJobSpecs,
} from "../../scripts/lib/ci-job-p90.mjs";

// #4691 (item 3 of #3920): nothing compared a required CI job's measured
// runtime with its `timeout-minutes`. The TLA+ cap (720 s) was found only when
// PRs timed out (623-881 s, #3918). These tests drive the pure computation on a
// recorded master-run fixture; the gh fetch is the only host boundary and lives
// in scripts/check-ci-job-p90.mjs.

const ROOT = resolve(import.meta.dirname, "..", "..");
const ciWorkflow = load(
	readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, unknown> };
const fixture = JSON.parse(
	readFileSync(
		resolve(ROOT, "tests/fixtures/ci-job-p90/master-runs.json"),
		"utf8",
	),
) as { runs: Parameters<typeof p90Warnings>[0]["runs"] };

function withShardsAt(seconds: number) {
	return fixture.runs.map((run) => ({
		...run,
		jobs: run.jobs.map((job) => {
			if (!job.name.startsWith("Unit tests (shard")) return job;
			const started = Date.parse(job.started_at as string);
			return {
				...job,
				completed_at: new Date(started + seconds * 1000)
					.toISOString()
					.replace(".000Z", "Z"),
			};
		}),
	}));
}

describe("required CI job p90 against timeout-minutes (#4691)", () => {
	// Recurrence: #3918 (TLA+ shards timed out at 623-881 s against a 720 s cap).
	it("warns on a job at 75% of its cap and stays silent at 60%", () => {
		const specs = requiredJobSpecs(ciWorkflow);
		const { warnings } = p90Warnings({ specs, runs: fixture.runs });
		expect(warnings.map((w) => w.key)).toEqual(["lint-and-typecheck"]);
		const line = formatP90Warning(warnings[0]);
		expect(line).toContain('"Lint & type-check"');
		expect(line).toContain("p90 450 s");
		expect(line).toContain("75.0% of its 600 s cap");
		expect(line).toContain("timeout-minutes 10");
		expect(line).toContain("5 master runs 2026-10-18 to 2026-10-22");
		expect(line).toContain("5 samples");
	});

	it("names the job, p90, cap and run window in the warning line", () => {
		const specs = requiredJobSpecs(ciWorkflow);
		const [w] = p90Warnings({ specs, runs: fixture.runs }).warnings;
		expect(w.p90Seconds).toBe(450);
		expect(w.capSeconds).toBe(600);
		expect(w.window).toEqual({ runs: 5, from: "2026-10-18", to: "2026-10-22" });
	});

	it("emits one record per job per run, never one per shard sample", () => {
		// Recurrence: #4691 acceptance 3. The shard matrix has 10 samples (5 runs
		// x 2 shards); pushing them all over the cap must still give one record.
		const specs = requiredJobSpecs(ciWorkflow);
		const { warnings } = p90Warnings({
			specs,
			runs: withShardsAt(1350),
		});
		const shardWarnings = warnings.filter((w) => w.key === "test");
		expect(shardWarnings).toHaveLength(1);
		expect(shardWarnings[0].samples).toBe(10);
		expect(shardWarnings[0].capSeconds).toBe(1800);
	});

	it("reads the required jobs and their caps from the real ci.yml", () => {
		const specs = requiredJobSpecs(ciWorkflow);
		const byKey = Object.fromEntries(specs.map((s) => [s.key, s]));
		expect(byKey.test?.capMinutes).toBe(30);
		expect(byKey["unit-tests"]?.capMinutes).toBe(10);
		expect(byKey["lint-and-typecheck"]?.capMinutes).toBe(10);
		// Not a required check: its 1500 s runs at a 1500 s cap would warn if it
		// were wrongly admitted.
		expect(byKey["unit-tests-windows"]).toBeUndefined();
	});

	it("ignores skipped and untimed rows, and reports jobs with no samples", () => {
		const specs = requiredJobSpecs(ciWorkflow);
		const runs = [
			{
				id: 1,
				created_at: "2026-10-18T10:00:00Z",
				jobs: [
					{
						name: "Lint & type-check",
						started_at: null,
						completed_at: null,
						conclusion: "skipped",
					},
				],
			},
		];
		const result = p90Warnings({ specs, runs });
		expect(result.warnings).toEqual([]);
		const lint = result.skipped.find((s) => s.key === "lint-and-typecheck");
		expect(lint?.reason).toBe("no samples");
	});

	it("keeps exactly-70% quiet and warns just above it (strictly over the ratio)", () => {
		expect(P90_CAP_RATIO).toBe(0.7);
		const specs = requiredJobSpecs(ciWorkflow);
		// lint cap is 600 s: 420 s is exactly 70%, 421 s is over it.
		const at = (s: number) =>
			p90Warnings({
				specs,
				runs: fixture.runs.map((run) => ({
					...run,
					jobs: run.jobs.map((job) =>
						job.name === "Lint & type-check"
							? {
									...job,
									completed_at: new Date(
										Date.parse(job.started_at as string) + s * 1000,
									)
										.toISOString()
										.replace(".000Z", "Z"),
								}
							: job,
					),
				})),
			}).warnings.map((w) => w.key);
		expect(at(420)).toEqual([]);
		expect(at(421)).toEqual(["lint-and-typecheck"]);
	});

	it("nearest-rank p90", () => {
		expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
		expect(p90([5])).toBe(5);
		expect(p90([])).toBeUndefined();
	});
});
