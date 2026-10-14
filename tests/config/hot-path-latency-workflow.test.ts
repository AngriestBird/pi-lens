// Pins the #4363 hot-path latency lane to its workflow-level contract. The real
// YAML is loaded, so each assertion reds on the edit that would break it.
//
// Recurrences this prevents:
//  - the lane's streak (10 consecutive green master push runs before it may
//    gate) reads the RUN conclusion. A `continue-on-error` job concludes success
//    on a regression, so the streak would count a red as green;
//  - an Actions cache added to the lane: the repository sits at its 10 GB cap
//    (#4358) and every cache write evicts an entry CI needs;
//  - the script's own time budget raised past the job cap, which would let a
//    hung sample end as a cancelled run instead of a harness failure;
//  - the pull_request and push path filters drifting apart, so master runs a
//    different population than the PRs it is compared with.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { DEFAULT_BUDGET_MS } from "../../scripts/check-hot-path-latency.mjs";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
const workflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/hot-path-latency.yml"), "utf8"),
) as {
	on: {
		pull_request: { paths: string[] };
		push: { branches: string[]; paths: string[] };
	};
	permissions: unknown;
	jobs: Record<
		string,
		{
			name: string;
			"continue-on-error"?: unknown;
			"timeout-minutes": number;
			permissions: Record<string, string>;
			steps: Step[];
		}
	>;
};
const job = workflow.jobs.latency;

describe("hot-path latency workflow (#4363)", () => {
	it("is named advisory and keeps a truthful run conclusion", () => {
		expect(isAdvisoryCheck(job.name)).toBe(true);
		expect(job["continue-on-error"]).toBeUndefined();
	});

	it("uses no Actions cache (#4358)", () => {
		for (const step of job.steps) {
			expect(step.uses ?? "").not.toMatch(/actions\/cache/);
			expect(step.with?.cache).toBeUndefined();
		}
	});

	it("bounds the script's own budget at half the job cap", () => {
		expect(DEFAULT_BUDGET_MS / 60_000).toBeLessThanOrEqual(
			job["timeout-minutes"] / 2,
		);
	});

	it("runs on the same paths for pull requests and master pushes", () => {
		expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths);
		expect(workflow.on.push.branches).toEqual(["master"]);
		expect(workflow.on.pull_request.paths).toEqual(
			expect.arrayContaining([
				"clients/**",
				"index.ts",
				"scripts/hot-path-sample.mjs",
				"scripts/check-hot-path-latency.mjs",
				".github/workflows/hot-path-latency.yml",
			]),
		);
	});

	it("is read-only and runs the gate script over two built trees", () => {
		expect(workflow.permissions).toEqual({});
		expect(job.permissions).toEqual({ contents: "read" });
		const runs = job.steps.map((s) => s.run ?? "").join("\n");
		expect(runs).toMatch(/node scripts\/check-hot-path-latency\.mjs/);
		expect(runs.match(/npm run build/g)).toHaveLength(2);
		// The base is the checked-out commit's first parent: master's tip on a
		// pull request's merge ref, the previous commit on a push.
		expect(runs).toContain("git rev-parse HEAD^1");
	});
});
