// #4005 (from the #3995 census): the Stryker mutation lane is a nightly,
// exploratory test-adequacy report, not a per-PR job. The real YAML is loaded
// and judged by one shape function; each MUTATION case below plants one
// regression into the real text and expects the function to name it.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const NIGHTLY = ".github/workflows/stryker-nightly.yml";
const nightlySource = readFileSync(resolve(ROOT, NIGHTLY), "utf8");

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	if?: string;
	run?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, unknown>;
};
type Job = {
	permissions?: Record<string, string>;
	steps?: Step[];
	"timeout-minutes"?: number;
};
type Workflow = {
	on?: Record<string, unknown>;
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

const load = (text: string) => yaml.load(text) as Workflow;
const WRITE_GUARD =
	"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";

/** Every way the nightly workflow can stop being the #4005 shape. */
function nightlyFindings(text: string): string[] {
	const findings: string[] = [];
	const workflow = load(text);
	const triggers = Object.keys(workflow.on ?? {});
	for (const forbidden of [
		"pull_request",
		"pull_request_target",
		"push",
		"merge_group",
	]) {
		if (triggers.includes(forbidden)) findings.push(`trigger: ${forbidden}`);
	}
	if (!triggers.includes("schedule")) findings.push("no schedule trigger");
	if (JSON.stringify(workflow.permissions) !== "{}")
		findings.push("workflow-level permissions are not {}");

	const jobs = Object.entries(workflow.jobs ?? {});
	if (jobs.length !== 1) findings.push(`jobs: ${jobs.length}, expected 1`);
	const [, job] = jobs[0] ?? ["", {} as Job];
	if (
		JSON.stringify(Object.entries(job.permissions ?? {}).sort()) !==
		JSON.stringify([
			["contents", "read"],
			["issues", "write"],
		])
	) {
		findings.push(
			`job permissions ${JSON.stringify(job.permissions)} are not contents:read + issues:write`,
		);
	}

	const steps = job.steps ?? [];
	const run = (step: Step) => step.run ?? "";
	const window = steps.find((step) => step.id === "window");
	if (!/-- clients tools mcp index\.ts\b/.test(run(window ?? {})))
		findings.push("window step does not scope the diff to the runtime paths");
	if (
		!/stryker-nightly\.mjs base .*--title "\$TRACKING_TITLE"/.test(
			run(window ?? {}),
		)
	)
		findings.push(
			"window step does not read the state under the tracking title",
		);

	const driver = steps.find((step) =>
		run(step).includes("scripts/stryker-diff.mjs"),
	);
	if (!driver || !/--base "\$BASE"/.test(run(driver)))
		findings.push("driver step is not run over the window's base");
	if (driver && driver["continue-on-error"] !== true)
		findings.push("driver failure would skip the tracking-issue step");

	const upsert = steps.find((step) =>
		run(step).includes("scripts/upsert-tracking-issue.mjs"),
	);
	if (
		!upsert ||
		!/upsert-tracking-issue\.mjs --title "\$TRACKING_TITLE" --label nightly-drift --body-file/.test(
			run(upsert),
		)
	)
		findings.push("no title-keyed upsert step on the nightly-drift label");
	if (upsert && !(upsert.if ?? "").includes(WRITE_GUARD))
		findings.push("the issue writer is not scoped to schedule or master");
	if (/gh issue (create|edit|comment|close)/.test(steps.map(run).join("\n")))
		findings.push("a raw gh issue write bypasses the shared upsert CLI");

	if (
		!steps.some((step) =>
			/^steps\.stryker\.outcome == 'failure'$/.test(step.if ?? ""),
		)
	)
		findings.push("no step turns a driver failure into a red run");
	const checkout = steps.find((step) =>
		step.uses?.startsWith("actions/checkout@"),
	);
	if (checkout?.with?.["fetch-depth"] !== 0)
		findings.push("checkout is shallow: git diff <sha>..HEAD needs history");
	return findings;
}

describe("stryker-nightly.yml (#4005)", () => {
	it("has exactly the nightly report shape", () => {
		expect(nightlyFindings(nightlySource)).toEqual([]);
	});

	// Recurrence: #3995's census, 11-18% of CI job-minutes per push for no
	// product defect. Nothing but the nightly workflow may run the driver, and
	// no workflow that can start on a pull request may mention it.
	it("is the only workflow that runs the Stryker driver, and none reachable from a pull request does", () => {
		const offenders: string[] = [];
		const entries = readdirSync(WORKFLOWS).filter((entry) =>
			/\.ya?ml$/.test(entry),
		);
		// 21 workflow files on 2026-10-07; half, rounded down.
		assertNonEmptyScan(
			"workflow files walked for the Stryker driver",
			entries.length,
			10,
		);
		for (const entry of entries) {
			const text = readFileSync(resolve(WORKFLOWS, entry), "utf8");
			const triggers = Object.keys(load(text).on ?? {});
			const touchesPullRequest = triggers.some((trigger) =>
				["pull_request", "pull_request_target", "merge_group"].includes(
					trigger,
				),
			);
			const runsDriver =
				/stryker-diff\.mjs|stryker-mutator|mutation-report/.test(text);
			if (runsDriver && entry !== "stryker-nightly.yml")
				offenders.push(`${entry} runs the driver`);
			if (runsDriver && touchesPullRequest)
				offenders.push(`${entry} is reachable from a pull request`);
		}
		expect(offenders).toEqual([]);
	});

	// Recurrence (#3801 -> #4005): the lane returned as a `mutation` job in
	// ci.yml, where it queues behind the heavy gate on every code PR.
	it("leaves no mutation job and no sticky-comment script in ci.yml", () => {
		const ci = load(readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8"));
		expect(
			Object.keys(ci.jobs ?? {}).filter((id) => /mutation/i.test(id)),
		).toEqual([]);
		expect(readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8")).not.toMatch(
			/mutation-pr-comment|stryker/i,
		);
	});

	// The per-case mutations: each takes the REAL workflow text, plants one
	// regression, and demands the shape function names it.
	const mutations: Array<[string, (text: string) => string, RegExp]> = [
		[
			"re-adding the pull_request trigger",
			(text) =>
				text.replace("on:\n", "on:\n  pull_request:\n    branches: [master]\n"),
			/trigger: pull_request/,
		],
		[
			"re-adding a push trigger",
			(text) => text.replace("on:\n", "on:\n  push:\n    branches: [master]\n"),
			/trigger: push/,
		],
		[
			"dropping the schedule",
			(text) => text.replace(/  schedule:\n    - cron: [^\n]*\n/, ""),
			/no schedule trigger/,
		],
		[
			"widening the job's permissions",
			(text) =>
				text
					.replace(
						"      issues: write\n",
						"      issues: write\n      contents: write\n",
					)
					.replace("      contents: read\n", ""),
			/job permissions/,
		],
		[
			"dropping the job's issues: write",
			(text) => text.replace("      issues: write\n", ""),
			/job permissions/,
		],
		[
			"widening the workflow-level permissions",
			(text) => text.replace("permissions: {}", "permissions: write-all"),
			/workflow-level permissions/,
		],
		[
			"dropping the upsert step's schedule/master scope",
			(text) =>
				text.replace(
					"(github.event_name == 'schedule' || github.ref == 'refs/heads/master')",
					"true",
				),
			/not scoped to schedule or master/,
		],
		[
			"replacing the shared upsert with a raw gh issue write",
			(text) =>
				text.replace(
					'node scripts/upsert-tracking-issue.mjs --title "$TRACKING_TITLE"',
					'gh issue create --title "$TRACKING_TITLE"',
				),
			/no title-keyed upsert step|raw gh issue write/,
		],
		[
			"letting a driver failure skip the tracking issue",
			(text) =>
				text.replace(
					"        continue-on-error: true\n        env:\n          BASE",
					"        env:\n          BASE",
				),
			/driver failure would skip/,
		],
		[
			"a shallow checkout",
			(text) => text.replace("          fetch-depth: 0\n", ""),
			/checkout is shallow/,
		],
		[
			"widening the diff scope away from the runtime paths",
			(text) => text.replace("-- clients tools mcp index.ts", "-- ."),
			/runtime paths/,
		],
	];

	it.each(mutations)(
		"MUTATION: %s reds the shape",
		(_label, mutate, expected) => {
			const mutated = mutate(nightlySource);
			expect(mutated, "the mutation must change the workflow").not.toBe(
				nightlySource,
			);
			expect(nightlyFindings(mutated).join("\n")).toMatch(expected);
		},
	);
});
