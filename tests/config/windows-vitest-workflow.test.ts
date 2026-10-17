import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { siblingPin } from "../support/sibling-pin.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	shell?: string;
	id?: string;
	if?: string;
	"continue-on-error"?: boolean;
};
type Job = {
	name?: string;
	"runs-on"?: string;
	"continue-on-error"?: boolean;
	"timeout-minutes"?: number;
	needs?: string | string[];
	if?: string;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	steps?: Step[];
};

function readWorkflow(): { jobs: Record<string, Job> } {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<string, Job>;
	};
}

describe("Windows Vitest workflow contract (#2536)", () => {
	it("keeps the Windows subset lane present, bounded, and gating (#4518)", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		// #4518: promoted from `(advisory)` on 2026-10-17. The name carries no
		// suffix, so ci-verdict gates it, and no `needs:`/`if:` scales it back
		// behind the heavy gate -- a required row that a docs-only diff skips
		// would be absent forever.
		expect(job?.name).toBe("Unit tests Windows");
		expect(job?.["runs-on"]).toBe("windows-latest");
		expect(job?.["continue-on-error"]).toBeUndefined();
		expect(job?.["timeout-minutes"]).toBe(25);
		expect(job?.outputs?.windows_vitest).toBe(
			"${{ steps.windows-vitest.outcome }}",
		);
		expect(job?.permissions).toEqual({ contents: "read" });
		expect(job?.needs).toBeUndefined();
		expect(job?.if).toBeUndefined();
	});

	it("keeps dynamic Windows enumeration and the runner command wired", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const enumeration = steps.find(
			(step) => step.name === "Enumerate Windows Vitest subset",
		);
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const outcome = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);

		// Recurrence: #2536's Windows-only tests were present but had no CI
		// consumer; deleting either population source would silently recreate it.
		expect(enumeration?.shell).toBe("bash");
		expect(enumeration?.run).toContain(
			"node scripts/lib/win32-gate-population.mjs --files",
		);
		expect(enumeration?.run).not.toMatch(/git grep/);
		expect(enumeration?.run).toContain("${#FILES[@]} -eq 0");
		expect(raw).toContain("win32-gate-population.mjs --summary");
		expect(runner?.run).toContain("--configLoader runner");
		expect(runner?.id).toBe("windows-vitest");
		// #4518: the run step reports its own red. `continue-on-error` here would
		// let a future edit of the failure step turn a red subset green, the
		// #4019 shape that hid 56 failed Windows tests.
		expect(runner?.["continue-on-error"]).toBeUndefined();
		expect(outcome?.if).toBe("always()");
		expect(raw).toContain("Windows Vitest subset step outcome:");
		expect(raw).toContain("windows_vitest=$outcome");
		expect(raw).toContain("PI_LENS_TEST_TIMEOUT_SCALE: '3'");
	});

	// #3926: a failed checkout leaves no repository and the enumeration step is
	// skipped, so the summary must not invoke the checked-out population script;
	// it reports "Not executed" and still writes the outcome keys the job output
	// reads. The node invocation stays inside the list-present branch.
	it("guards the Windows summary on the executed-file list", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const outcome = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const run = String(outcome?.run ?? "");
		expect(outcome?.if).toBe("always()");
		const guard = run.indexOf('[ -f "$RUNNER_TEMP/windows-vitest-files.txt" ]');
		const population = run.indexOf("win32-gate-population.mjs --summary");
		const unavailable = run.indexOf("Not executed");
		const key = run.indexOf("windows_vitest=$outcome");
		expect(guard).toBeGreaterThan(-1);
		expect(population).toBeGreaterThan(guard);
		expect(unavailable).toBeGreaterThan(population);
		expect(key).toBeGreaterThan(-1);
	});

	it("publishes a visible red after recording the failed Vitest count", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const record = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = steps.find(
			(step) =>
				step.name === "Fail a failed or under-executed Windows Vitest subset",
		);

		// Recurrence: #4019's continue-on-error made 56 failed Windows tests read
		// as a green job, hiding the red from both reviewers and ci-verdict.
		expect(record?.run).toContain(
			'windows-vitest-failure-count.mjs "$RUNNER_TEMP/windows-vitest.log"',
		);
		expect(record?.run).toContain("Windows Vitest failures:");
		expect(failure?.if).toBe("always()");
		expect(failure?.run).toContain("steps.windows-vitest.outcome");
		expect(failure?.run).toContain("exit 1");
		expect(failure?.run).toContain("title=Windows Vitest subset::");
		// #4518: the red is the run step's own failure now; no step of this job
		// needs `continue-on-error`, so a broken failure step cannot hide it.
		expect(
			steps.filter((entry) => entry["continue-on-error"] !== undefined),
		).toEqual([]);
	});

	// Recurrence: #4042 review F1 — a Vitest crash creates an empty log, so an
	// absent summary must stay visibly unavailable rather than becoming zero.
	it("reports an unknown count when Vitest emits no summary", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const record = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = (job?.steps ?? []).find(
			(step) =>
				step.name === "Fail a failed or under-executed Windows Vitest subset",
		);
		expect(record?.run).toContain(
			"Windows Vitest failures: ${failures:-unknown}",
		);
		expect(failure?.run).toContain("${failures:-unknown} Vitest tests failed");
		expect(raw).not.toContain("Windows Vitest failures: ${failures:-0}");
	});

	// #4591: the one governance file declined on this lane. The census reds ~1 run
	// in 10 there on a root its own file's teardown had already removed, and the
	// lane gates now, so that verdict is postponed until the producer is named.
	// A source read, not a tests/-tree sweep: this pins the ONE condition (a
	// platform test, never a constant, so it cannot be widened to every lane
	// silently) and the issue that retires it. A second quarantined file is a
	// reviewed change, not a population this case can enumerate.
	it("keeps the tmp-fixture census quarantine on win32, named to its issue (#4591)", () => {
		const quarantined = readFileSync(
			resolve(ROOT, "tests/config/tmp-fixture-hygiene.test.ts"),
			"utf8",
		);
		expect(quarantined).toContain(
			'const WINDOWS_QUARANTINE = process.platform === "win32";',
		);
		expect(quarantined).toMatch(/#4591:\s*quarantined on the Windows lane/);
	});

	it("pins the sibling action revisions and the isolated home", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
			siblingPin(readWorkflow().jobs, "actions/checkout", "unit-tests-windows"),
			siblingPin(
				readWorkflow().jobs,
				"actions/setup-node",
				"unit-tests-windows",
			),
		]);
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		expect(raw).toContain(
			'PI_LENS_HOME=$RUNNER_TEMP/pi-lens-home" >> "$GITHUB_ENV"',
		);
		expect(raw).toContain("npm ci --no-audit --no-fund");
		expect(raw).toContain("npm run build");
	});
});
