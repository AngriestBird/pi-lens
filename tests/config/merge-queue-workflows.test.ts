import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { REQUIRED_CHECKS } from "../../scripts/lib/ci-checks.mjs";

// #3754: GitHub's merge queue tests each queued PR on a `merge_group` commit
// and waits for the required checks to report THERE. A required check whose
// workflow has no `merge_group` trigger never reports on that commit, so the
// queue waits until its timeout and ejects every PR. This file pins the
// trigger on each workflow that produces a required check, and that no
// required job is gated off on that event.

const ROOT = resolve(import.meta.dirname, "../..");

type Job = { name?: string; if?: string; needs?: string | string[] };
type Workflow = {
	on?: Record<string, unknown> | string[] | string;
	jobs: Record<string, Job>;
};
const load = (file: string) =>
	yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as Workflow;

// The required checks, as branch protection names them on master (read live on
// 2026-09-30 with `gh api repos/apmantza/pi-lens/branches/master/protection`:
// Lint & type-check, Unit tests, Install test x3, knip, oxfmt format check).
// GitHub is the source of truth and is not readable from a test, so this list
// is the one hand-kept mirror; the REQUIRED_CHECKS subset assertion below
// keeps it from drifting away from the script-side list.
const REQUIRED_JOBS = [
	{
		file: ".github/workflows/ci.yml",
		job: "lint-and-typecheck",
		name: "Lint & type-check",
	},
	{ file: ".github/workflows/ci.yml", job: "unit-tests", name: "Unit tests" },
	{
		file: ".github/workflows/ci.yml",
		job: "install-test",
		name: "Install test (${{ matrix.os }})",
	},
	{ file: ".github/workflows/lint.yml", job: "knip", name: "knip" },
	{
		file: ".github/workflows/lint.yml",
		job: "oxfmt",
		name: "oxfmt format check",
	},
];
const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

describe("#3754 merge queue workflow contract", () => {
	// Recurrence it prevents: enabling the queue while a required-check
	// workflow lacks `merge_group` (a workflow added later, or a trigger block
	// rewritten) strands every queued PR until the queue's check timeout.
	it("runs every required-check workflow on merge_group", () => {
		for (const file of new Set(REQUIRED_JOBS.map((entry) => entry.file))) {
			const on = load(file).on as Record<string, unknown>;
			expect(Object.keys(on), file).toContain("merge_group");
			expect(on.merge_group, file).toEqual({ types: ["checks_requested"] });
		}
	});

	// Recurrence: the job ids above drifting from the workflow (a rename leaves
	// the pin green while pinning nothing).
	it("names each required job exactly as branch protection does", () => {
		for (const { file, job, name } of REQUIRED_JOBS) {
			expect(load(file).jobs[job]?.name, `${file}#${job}`).toBe(name);
		}
		for (const required of REQUIRED_CHECKS) {
			expect(
				REQUIRED_JOBS.map((entry) => entry.name),
				required,
			).toContain(required);
		}
	});

	// Recurrence: a required job (or a job it `needs:`) carrying
	// `if: github.event_name == 'pull_request'` is skipped on merge_group, and
	// the queue then sees a required check that never ran.
	it("does not gate any required job, or its needs chain, off merge_group", () => {
		for (const { file, job } of REQUIRED_JOBS) {
			const jobs = load(file).jobs;
			const chain = new Set<string>();
			const visit = (id: string) => {
				if (chain.has(id)) return;
				chain.add(id);
				for (const dependency of asList(jobs[id]?.needs)) visit(dependency);
			};
			visit(job);
			for (const id of chain) {
				const gate = jobs[id]?.if;
				expect(
					gate === undefined || gate === "always()",
					`${file}#${id} is in ${job}'s needs chain and carries if: ${gate}`,
				).toBe(true);
			}
		}
	});

	// Recurrence: the PR-only lanes (PR title/body, changelog fast-fail,
	// targeted advisory) read `github.event.pull_request`, which is empty on a
	// merge_group run. They must be skipped there, by an explicit
	// `pull_request` guard, never by failing.
	it("keeps every pull_request-context job guarded to pull_request", () => {
		const offenders: string[] = [];
		for (const file of [
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]) {
			const source = readFileSync(resolve(ROOT, file), "utf8");
			const { jobs } = load(file);
			for (const [id, job] of Object.entries(jobs)) {
				const gate = String(job.if ?? "");
				const usesPullRequestContext = jobUsesPullRequestContext(
					source,
					id,
					Object.keys(jobs),
				);
				if (
					usesPullRequestContext &&
					!gate.includes("github.event_name == 'pull_request'")
				)
					offenders.push(`${file}#${id}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

/** Does the job's own text read `github.event.pull_request.*` outside a
 *  ternary that falls back to `github.sha` (the metadata step's HEAD_SHA shape,
 *  which is merge_group-safe)? The job text is the source between its `  id:`
 *  header and the next job header. */
function jobUsesPullRequestContext(
	source: string,
	id: string,
	ids: string[],
): boolean {
	const start = source.indexOf(`\n  ${id}:\n`);
	const others = ids
		.map((other) => source.indexOf(`\n  ${other}:\n`))
		.filter((index) => index > start)
		.sort((a, b) => a - b);
	const text = source.slice(start, others[0] ?? source.length);
	const code = text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	return (
		/github\.event\.pull_request\.(?!head\.sha\b)/.test(code) ||
		/github\.event\.action\s*!=/.test(code)
	);
}
