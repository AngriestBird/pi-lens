import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import { stripSource } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = { uses?: unknown; run?: unknown };
type Job = {
	name?: string;
	if?: string;
	env?: unknown;
	steps?: unknown;
};
type Workflow = {
	on?: { pull_request?: unknown; pull_request_target?: unknown };
	env?: unknown;
	jobs?: Record<string, Job>;
};

function load(path: string): { workflow: Workflow; source: string } {
	const source = readFileSync(path, "utf8");
	return { workflow: yaml.load(source) as Workflow, source };
}

function jobSource(source: string, jobName: string): string {
	const stripped = stripSource(source, { strings: "blank" });
	const rawLines = source.split("\n");
	const lines = stripped.split("\n");
	const start = rawLines.findIndex((line) => line === `  ${jobName}:`);
	if (start < 0) throw new Error(`job ${jobName} not found`);
	const end = rawLines.findIndex(
		(line, index) => index > start && /^  [A-Za-z0-9_-]+:/.test(line),
	);
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function isActiveOnPullRequest(job: Job): boolean {
	return !job.if?.includes("github.event.workflow_run.");
}

function writesWithToken(jobText: string): boolean {
	return (
		/\bgh\s+(?:pr|issue)\s+(?:edit|comment|merge)\b/.test(jobText) ||
		/\bgh\s+api\b[\s\S]*?(?:-X|--method)\s+(?:POST|PATCH|PUT|DELETE)\b/.test(
			jobText,
		) ||
		/\bcurl\b[\s\S]*?(?:--request|-X)\s+(?:POST|PATCH|PUT|DELETE)\b/.test(
			jobText,
		) ||
		/\bcheck-close-keywords\.mjs\s+--verify-merged\b/.test(jobText) ||
		/\buses:\s*actions\/github-script@[^\s]+[\s\S]*?\bgithub\.rest\.(?:issues|pulls)\.(?:create|createComment|update|updateComment|delete|deleteComment|addLabels|removeLabel|addAssignees|removeAssignees|setLabels)\b/.test(
			jobText,
		)
	);
}

describe("fork-capped workflow token writes (#2993)", () => {
	it("guards or advisory-lists every active pull_request token write", () => {
		// Recurrence #2993: a fork pull_request receives a read-only token, so a
		// metadata write can fail and block the merge gate. Scan stripped source
		// so comments and quoted examples cannot launder a write or its guard.
		const findings: string[] = [];
		for (const name of readdirSync(WORKFLOWS)) {
			if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
			const path = resolve(WORKFLOWS, name);
			const { workflow, source } = load(path);
			if (!workflow.on?.pull_request) continue;
			for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
				if (
					!isActiveOnPullRequest(job) ||
					!writesWithToken(jobSource(source, key))
				) {
					continue;
				}
				const displayName = job.name ?? key;
				const guarded = job.if?.includes(
					"github.event.pull_request.head.repo.full_name == github.repository",
				);
				if (
					!guarded &&
					!isAdvisoryCheck(displayName) &&
					!isAdvisoryCheck(key)
				) {
					findings.push(`${name}:${key} (${displayName})`);
				}
			}
		}
		expect(findings, "fork-capped token writes must be contained").toEqual([]);
	});

	it("rejects a same-shaped write without a fork guard or advisory name", () => {
		// Reject twin: the nearest wrong shape must remain visible to prevent a
		// comment-only guard or an unrelated advisory entry from clearing it.
		const source = `  dangerous:\n    name: Dangerous\n    if: github.event_name == 'pull_request'\n    run: gh pr edit 123 --remove-label x`;
		const job = {
			name: "Dangerous",
			if: "github.event_name == 'pull_request'",
		};
		expect(writesWithToken(jobSource(source, "dangerous"))).toBe(true);
		expect(job.if).not.toContain("head.repo.full_name == github.repository");
		expect(isAdvisoryCheck(job.name)).toBe(false);
	});

	it("detects github-script REST writes after source blanking", () => {
		const source = `  mutator:
    name: Mutator
    uses: actions/github-script@v7
    with:
      script: |
        await github.rest.issues.createComment({ issue_number: 1 });`;
		expect(writesWithToken(jobSource(source, "mutator"))).toBe(true);
	});

	it("does not classify github-script REST reads as writes", () => {
		const source = `  reader:
    name: Reader
    uses: actions/github-script@v7
    with:
      script: |
        await github.rest.issues.get({ issue_number: 1 });`;
		expect(writesWithToken(jobSource(source, "reader"))).toBe(false);
	});

	it("detects curl short-form write methods", () => {
		const source = `  mutator:
    name: Mutator
    run: curl -X PATCH https://api.github.com/repos/example/repo/issues/1`;
		expect(writesWithToken(jobSource(source, "mutator"))).toBe(true);
	});

	it("keeps greeting outside the fork-capped population", () => {
		const { workflow } = load(resolve(WORKFLOWS, "greetings.yml"));
		expect(workflow.on?.pull_request).toBeUndefined();
		expect(isAdvisoryCheck("greeting")).toBe(true);
	});

	it("skips cleanup when the synchronize PR head is a fork", () => {
		const { workflow } = load(resolve(WORKFLOWS, "ci-infra-kill-rerun.yml"));
		expect(workflow.jobs?.["clear-stale-verdict-labels"]?.if).toContain(
			"github.event.pull_request.head.repo.full_name == github.repository",
		);
	});

	it("runs merged-PR comment verification on the uncapped target trigger", () => {
		const { workflow } = load(
			resolve(WORKFLOWS, "close-keyword-verification.yml"),
		);
		expect(workflow.on?.pull_request_target).toBeDefined();
	});
});

// A `gh` call resolves its repository from one of three sources: `GH_REPO`, the
// checkout's git remote, or an explicit `-R`/`--repo`. A job that offers none
// dies where it writes, with `failed to run git: fatal: not a git repository`.
//
// #4382 named that on the push lane, where the fix removed the wrong PR number.
// Its PR-lane sibling stayed: `finalize-rerun` has no checkout and no `GH_REPO`,
// so run 38956598286 (2026-10-16, attempt 2 green) failed in "Swap terminal
// rerun labels" and the terminal verdict label was never swapped. Six of six
// runs that reached that write failed the same way, the first on 2026-10-10
// (run 38459454960), so the defect predates #4386 and is not a regression of it.
const GH_CALL =
	/(^|[\s;&|(`])gh\s+(?:pr|issue|api|run|workflow|release|label|repo)\b/;
const REPO_OPERAND = /(^|[\s;&|(`])(?:-R|--repo)[\s=]/;
// `gh api --method POST /repos/<repo>/…` names its repository in the path.
const API_REPO_PATH =
	/\/repos\/(?:\$GITHUB_REPOSITORY|\$\{\{\s*github\.repository\s*\}\}|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\//;

function runLines(job: Job): string[] {
	const lines: string[] = [];
	for (const step of (job.steps ?? []) as Step[]) {
		if (typeof step.run !== "string") continue;
		for (const line of step.run.split("\n")) {
			// A shell comment cannot issue a call; without this, documentation
			// inside a step would red a job that writes nothing.
			if (/^\s*#/.test(line)) continue;
			lines.push(line);
		}
	}
	return lines;
}

function ghCalls(job: Job): string[] {
	return runLines(job).filter((line) => GH_CALL.test(line));
}

function hasRepositorySource(workflow: Workflow, job: Job): boolean {
	const env = (scope: unknown): Record<string, unknown> =>
		typeof scope === "object" && scope !== null
			? (scope as Record<string, unknown>)
			: {};
	if (String(env(job.env).GH_REPO ?? env(workflow.env).GH_REPO ?? "").trim()) {
		return true;
	}
	const steps = (job.steps ?? []) as Step[];
	if (steps.some((step) => /^actions\/checkout@/.test(String(step.uses)))) {
		return true;
	}
	const calls = ghCalls(job);
	return calls.some(
		(line) =>
			REPO_OPERAND.test(line) ||
			(/\bgh\s+api\b/.test(line) && API_REPO_PATH.test(line)),
	);
}

function jobsWithoutRepositorySource(workflow: Workflow): string[] {
	const missing: string[] = [];
	for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
		if (ghCalls(job).length === 0) continue;
		if (!hasRepositorySource(workflow, job)) missing.push(key);
	}
	return missing;
}

describe("workflow gh calls resolve a repository (#4382)", () => {
	it("gives every gh-invoking job of every workflow a repository source", () => {
		const findings: string[] = [];
		for (const name of readdirSync(WORKFLOWS).sort()) {
			if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
			const { workflow } = load(resolve(WORKFLOWS, name));
			for (const key of jobsWithoutRepositorySource(workflow)) {
				findings.push(`${name}:${key}`);
			}
		}
		expect(
			findings,
			"a gh call with no GH_REPO, checkout, or -R dies on repo resolution",
		).toEqual([]);
	});

	it("flags the pre-fix finalize-rerun job shape, naming the job", () => {
		// Reject twin: the nearest wrong shape -- a gh write with no repository
		// source -- must stay visible, and the record must name the job.
		const workflow = yaml.load(
			[
				"on: {workflow_run: null}",
				"jobs:",
				"  finalize-rerun:",
				"    runs-on: ubuntu-latest",
				"    env:",
				"      GH_TOKEN: secret",
				"    steps:",
				"      - run: |",
				"          gh pr edit 4550 --add-label ci:real",
				"  classify:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v7",
				"      - run: gh pr edit 4550 --add-label ci:real",
			].join("\n"),
		) as Workflow;
		expect(jobsWithoutRepositorySource(workflow)).toEqual(["finalize-rerun"]);
	});

	it("does not read a commented-out gh call as one", () => {
		const workflow = yaml.load(
			[
				"on: {workflow_run: null}",
				"jobs:",
				"  docs:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: |",
				"          # gh pr edit 4550 --add-label ci:real",
				"          echo hello",
			].join("\n"),
		) as Workflow;
		expect(jobsWithoutRepositorySource(workflow)).toEqual([]);
	});
});
