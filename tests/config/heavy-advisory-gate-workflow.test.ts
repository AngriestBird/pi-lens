// flake-shape: real-process-spawn — #3926 executes the real `Record Windows
// Vitest outcome` bash block at its true process boundary (a stub `node` on the
// child's PATH is the only mock), and drives the ref-deleted Git mechanism
// through the registered tests/support/git-fixture-env.ts seam. Both are the
// boundaries under test; no in-process double observes them.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import yaml from "../../clients/deps/js-yaml.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import {
	CHANGES_CHECK,
	DEFERRED_ADVISORY_CHECKS,
	HEAVY_GATE_CHECK,
	isAdvisoryCheck,
} from "../../scripts/lib/ci-checks.mjs";
import { DEFAULT_DEADLINE_SECONDS } from "../../scripts/ci-heavy-gate.mjs";

const byCodeUnit = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

// #3801: the heavy advisory jobs (mutation, the Windows Vitest subset) start
// only after the required checks passed on the same head. Each case names the
// regression it keeps out; the real YAML is loaded, never a source regex.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	with?: Record<string, string>;
	run?: string;
	env?: Record<string, string>;
};
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	"timeout-minutes"?: number;
	"continue-on-error"?: boolean;
	strategy?: { matrix?: { os?: string[]; language?: string[] } };
	steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const load = (file: string) =>
	yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as Workflow;
const asList = (needs: Job["needs"]) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

// The branch-protection contexts of master, probed 2026-09-30 with
// `gh api repos/apmantza/pi-lens/branches/master/protection/required_status_checks`.
// A ruleset change is not visible to this file; ci-verdict's live read is the
// runtime authority and this list is the workflow shape it must match.
const REQUIRED_CONTEXTS = [
	"Lint & type-check",
	"Unit tests",
	"Install test (ubuntu-latest)",
	"Install test (windows-latest)",
	"Install test (macos-latest)",
	"knip",
	"oxfmt format check",
	"TLA+ models",
];

/** Every check-run name a job can produce (a matrix expands its `name`). */
function checkNamesOf(job: Job): string[] {
	const name = job.name ?? "";
	const matrix = job.strategy?.matrix;
	if (matrix?.os)
		return matrix.os.map((os) => name.replace("${{ matrix.os }}", os));
	if (matrix?.language)
		return matrix.language.map((language) =>
			name.replace("${{ matrix.language }}", language),
		);
	return [name];
}

const CI = load(".github/workflows/ci.yml");
const LINT = load(".github/workflows/lint.yml");
const gate = CI.jobs["heavy-gate"];
const gated = Object.entries(CI.jobs).filter(
	([id, job]) =>
		id !== "heavy-gate" && asList(job.needs).includes("heavy-gate"),
);

describe("#3801 heavy advisory jobs wait for the required checks", () => {
	// Recurrence: a required check renamed or dropped from the workflows makes
	// its branch-protection context absent, which GitHub reads as never
	// reported. The gate can only wait on what exists.
	it("keeps every required context produced by exactly one workflow job", () => {
		const hosted = new Map<string, string>();
		for (const [file, workflow] of [
			["ci.yml", CI],
			["lint.yml", LINT],
		] as const) {
			for (const [id, job] of Object.entries(workflow.jobs)) {
				for (const name of checkNamesOf(job)) hosted.set(name, `${file}:${id}`);
			}
		}
		for (const context of REQUIRED_CONTEXTS) {
			expect(hosted.has(context), `${context} must exist as a job name`).toBe(
				true,
			);
		}
	});

	// Recurrence: a required job omitted from the gate's needs (for example a
	// new install-test leg job id) lets the heavy lane start while that check
	// is still red or running.
	it("needs every required job hosted by ci.yml", () => {
		const needs = asList(gate.needs);
		const ciRequired = REQUIRED_CONTEXTS.flatMap((context) =>
			Object.entries(CI.jobs)
				.filter(([, job]) => checkNamesOf(job).includes(context))
				.map(([id]) => id),
		);
		expect([...new Set(ciRequired)].sort(byCodeUnit)).toEqual([
			"install-test",
			"lint-and-typecheck",
			"tla-models",
			"unit-tests",
		]);
		for (const id of ciRequired) expect(needs).toContain(id);
	});

	// Recurrence (#3801 docs-only scope): a gate that starts on a docs-only diff
	// would launch mutation and the Windows run for a change the maintainer wants
	// spared them. And a status function in the gate's `if` (always(),
	// cancelled(), failure()) would replace the implicit success() over its
	// needs, releasing the heavy jobs on a head whose required job is red.
	it("starts only for a code diff, and only when every needed job succeeded", () => {
		expect(asList(gate.needs)).toContain("changes");
		expect(gate.if).toBe("needs.changes.outputs.code == 'true'");
		expect(gate.if).not.toMatch(/\b(always|cancelled|failure|success)\(\)/);
	});

	// Recurrence (review r1 F3): ci-verdict reads the gate's and the changes
	// job's rows by name to tell a deferred run from a dropped one; a renamed
	// job silently reads every head as "older workflow".
	it("names the two jobs ci-verdict reads the deferred state from", () => {
		expect(gate.name).toBe(HEAVY_GATE_CHECK);
		expect(CI.jobs.changes.name).toBe(CHANGES_CHECK);
	});

	// Recurrence: `needs:` cannot reach lint.yml, so a required check hosted
	// there (knip, oxfmt) was simply not waited for. The gate step names each
	// one; a context hosted by lint.yml but missing from `--context` fails here.
	it("waits, through the script, for every required context that lint.yml hosts", () => {
		const step = gate.steps?.find((entry) => entry.id === "gate");
		const args = [
			...String(step?.run).matchAll(/--context (?:"([^"]+)"|(\S+))/g),
		].map((match) => match[1] ?? match[2]);
		const lintHosted = REQUIRED_CONTEXTS.filter((context) =>
			Object.values(LINT.jobs).some((job) =>
				checkNamesOf(job).includes(context),
			),
		);
		expect(lintHosted.length).toBeGreaterThan(0);
		expect([...args].sort(byCodeUnit)).toEqual(
			[...lintHosted].sort(byCodeUnit),
		);
	});

	// Recurrence (#3807 head 46f5f5ebf, knip RED): knip reads every workflow
	// `run:` line as a command, and `node script.mjs --require <x>` parses as
	// node's own `--require` preload, so `"oxfmt format check"` reported as an
	// unresolved import and the required knip check went red. A script flag
	// must not share a spelling with a node option.
	it("never spells a script flag like a node option in a run: command", () => {
		const nodeOptions =
			/\bnode\b[^\n|&;]*?\s(--require|-r|--import|--check|-c|--eval|-e|--print|-p)\b/;
		const offenders: string[] = [];
		for (const [id, job] of Object.entries(CI.jobs)) {
			for (const step of job.steps ?? []) {
				for (const line of String(step.run ?? "").split("\n")) {
					// a flag AFTER the script path belongs to the script, but knip
					// cannot tell; flag only the ambiguous spellings
					if (/\bnode\s+scripts\/\S+/.test(line) && nodeOptions.test(line))
						offenders.push(`${id}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	// Recurrence: the output key or step id drifting makes every dependent's
	// `if:` false forever, so the heavy lanes silently never run.
	it("wires the job output `ready` to the script step and reads it in every dependent", () => {
		expect(gate.outputs?.ready).toBe("${{ steps.gate.outputs.ready }}");
		expect(gate.steps?.some((entry) => entry.id === "gate")).toBe(true);
		expect(gated.length).toBeGreaterThan(0);
		for (const [id, job] of gated) {
			expect(job.if, `${id} must test the gate's output`).toContain(
				"needs.heavy-gate.outputs.ready == 'true'",
			);
		}
	});

	// Recurrence: the deferred-row list in ci-checks.mjs (what ci-verdict shows
	// as PENDING) drifting from the jobs actually behind the gate.
	it("lists exactly the gated jobs as ci-verdict's deferred advisory checks", () => {
		expect(
			gated.flatMap(([, job]) => checkNamesOf(job)).sort(byCodeUnit),
		).toEqual([...DEFERRED_ADVISORY_CHECKS].sort(byCodeUnit));
	});

	// Recurrence (AGENTS.md shape 38): a heavy or gate row that gates. ci-verdict
	// and the merge train gate every non-advisory check-run.
	it("keeps the gate and everything behind it advisory and non-blocking", () => {
		expect(isAdvisoryCheck(gate.name ?? "")).toBe(true);
		for (const [, job] of gated)
			expect(isAdvisoryCheck(job.name ?? "")).toBe(true);
		const mutation = CI.jobs.mutation;
		expect(mutation["continue-on-error"]).toBe(true);
	});

	// Recurrence: a gate that polls a merge-ref sha finds no check-runs (they
	// hang on the PR head), reads "absent" for the full deadline and skips the
	// heavy lane on every PR.
	it("reads check-runs at the PR head sha, not the merge commit", () => {
		const step = gate.steps?.find((entry) => entry.id === "gate");
		expect(step?.env?.HEAD_SHA).toContain("github.event.pull_request.head.sha");
		expect(step?.env?.HEAD_SHA).toContain("|| github.sha");
		expect(gate.permissions?.checks).toBe("read");
	});

	// Recurrence: a gate job whose own ceiling is below its poll deadline is
	// killed mid-wait and reads as a red advisory row.
	it("bounds the gate's poll below its job timeout", () => {
		expect((gate["timeout-minutes"] ?? 0) * 60).toBeGreaterThan(
			DEFAULT_DEADLINE_SECONDS + 120,
		);
	});

	// Recurrence: the lane kept also running from its own ungated workflow. A
	// second `pull_request` mutation workflow would start the heavy run at once.
	it("has no ungated mutation workflow left beside the gated job", () => {
		expect(existsSync(resolve(ROOT, ".github/workflows/mutation.yml"))).toBe(
			false,
		);
		expect(CI.jobs.mutation.name).toBe("mutation (advisory)");
		expect(CI.jobs.mutation.if).toContain(
			"github.event_name == 'pull_request'",
		);
	});

	// Recurrence: the sticky-comment job running (and marking a stale comment)
	// on every red head, where the gate skipped mutation: a runner slot per red
	// push for no report.
	it("skips the sticky-comment job when mutation itself was skipped", () => {
		const comment = CI.jobs["mutation-comment"];
		expect(asList(comment.needs)).toEqual(["mutation"]);
		expect(comment.if).toContain("needs.mutation.result != 'skipped'");
		expect(comment.if).toContain("always()");
	});

	// Recurrence: #3756's aggregate lesson. A skipped required check counts as
	// passing, so the gate must never be (or replace) a required context.
	it("does not rename or replace any required context", () => {
		expect(REQUIRED_CONTEXTS).not.toContain(gate.name);
		expect(CI.jobs["unit-tests"].name).toBe("Unit tests");
		expect(CI.jobs["unit-tests"].if).toBe("always()");
	});
});

// #3926: the heavy advisory jobs start only after the required checks pass, so
// auto-merge may already have deleted the mutable `refs/pull/<n>/merge` that
// `github.ref` names. A gated checkout must rely on the action's default
// captured commit (`github.sha`, the validated test-merge tree), never on the
// ephemeral ref. The sibling gated jobs `mutation` and `codeql` already do.
// The rule is derived from `needs`, so a future gated job is covered.
describe("#3926 a gated checkout pins the captured commit, never the merge ref", () => {
	const checkoutSteps = (id: string): Step[] =>
		(CI.jobs[id]?.steps ?? []).filter(
			(step) => step.uses?.startsWith("actions/checkout@") === true,
		);
	const checkoutRefs = (id: string): Array<string | undefined> =>
		checkoutSteps(id).map((step) => step.with?.ref);

	// Recurrence (#3807/#3924): a gated job (or this one) restores
	// `ref: ${{ github.ref }}` and its checkout fetches a ref the merge deleted.
	it("keeps every checkout behind heavy-gate off the ephemeral pull ref", () => {
		const gatedIds = gated.map(([id]) => id);
		expect(gatedIds.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const id of gatedIds) {
			const steps = checkoutSteps(id);
			// A gated job with no checkout step would make the ref sweep
			// vacuous, so its absence is its own failure.
			expect(
				steps.length,
				`${id} must still check out the repository`,
			).toBeGreaterThan(0);
			for (const step of steps) {
				const ref = step.with?.ref;
				if (ref === undefined || ref === "${{ github.sha }}") continue;
				offenders.push(`${id}: ref=${ref}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// Positive pin: the one site #3807/#3924 proved red now uses the default.
	it("uses the captured commit on unit-tests-windows", () => {
		expect(checkoutRefs("unit-tests-windows")).not.toContain(
			"${{ github.ref }}",
		);
		expect(
			checkoutRefs("unit-tests-windows").every(
				(ref) => ref === undefined || ref === "${{ github.sha }}",
			),
		).toBe(true);
	});

	// The action's default is what makes the captured commit reachable; the
	// evaluated revision must stay pinned, not drift to a floating tag.
	it("keeps the pinned checkout revision", () => {
		for (const [id, job] of gated) {
			for (const step of job.steps ?? []) {
				if (!step.uses?.startsWith("actions/checkout@")) continue;
				expect(step.uses, `${id} checkout revision`).toBe(
					"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
				);
			}
		}
	});
});

// #3926 secondary defect: the always-run summary invoked the checked-out
// population script unconditionally, so after a failed checkout it died with
// `Cannot find module ... win32-gate-population.mjs` instead of reporting that
// the subset never ran. The cases execute the real `Record Windows Vitest
// outcome` `run:` block at a true process boundary (GitHub substitutes the one
// `steps.windows-vitest.outcome` expression); a stub `node` on the child PATH
// is the only mock.
describe("#3926 the Windows summary stays honest when the tree is unavailable", () => {
	const summaryStep = (CI.jobs["unit-tests-windows"]?.steps ?? []).find(
		(step) => step.name === "Record Windows Vitest outcome",
	);

	const fixture = setupTestEnvironment("pi-lens-3926-");
	let stubBin = "";

	beforeAll(() => {
		stubBin = resolve(fixture.tmpDir, "bin");
		mkdirSync(stubBin, { recursive: true });
		const stub = resolve(stubBin, "node");
		writeFileSync(
			stub,
			'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NODE_MARKER"\nexit 0\n',
		);
		chmodSync(stub, 0o755);
	});
	afterAll(() => fixture.cleanup());

	function runSummary(caseName: string, withList: boolean) {
		const runnerTemp = resolve(fixture.tmpDir, `runner-${caseName}`);
		mkdirSync(runnerTemp, { recursive: true });
		if (withList)
			writeFileSync(
				resolve(runnerTemp, "windows-vitest-files.txt"),
				"tests/a.test.ts\n",
			);
		const summary = resolve(fixture.tmpDir, `summary-${caseName}.md`);
		const marker = resolve(fixture.tmpDir, `node-${caseName}.marker`);
		const script = String(summaryStep?.run).replace(
			/\$\{\{\s*steps\.windows-vitest\.outcome\s*\}\}/,
			"skipped",
		);
		const result = spawnSync("bash", ["-c", script], {
			cwd: fixture.tmpDir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${stubBin}:${process.env.PATH ?? ""}`,
				GITHUB_STEP_SUMMARY: summary,
				RUNNER_TEMP: runnerTemp,
				NODE_MARKER: marker,
			},
		});
		return { result, summary, marker };
	}

	// Recurrence (#3924): the missing-module error replaced the real checkout
	// failure. With no list, the step exits 0, says "Not executed", and never
	// touches the checked-out script; the checkout step's own error stays the
	// visible cause.
	it("reports Not executed and never runs the script when the list is absent", () => {
		const { result, summary, marker } = runSummary("absent", false);
		expect(result.status, String(result.stderr)).toBe(0);
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("Not executed");
		expect(text).toContain("windows_vitest=skipped");
		expect(existsSync(marker)).toBe(false);
	});

	// The other direction: with the list present the guard must not swallow the
	// real population summary (the no-drop invariant beside the safety one).
	it("runs the population script and keeps its summary when the list exists", () => {
		const { result, summary, marker } = runSummary("present", true);
		expect(result.status, String(result.stderr)).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8")).toContain(
			"scripts/lib/win32-gate-population.mjs --summary",
		);
		const text = readFileSync(summary, "utf8");
		expect(text).not.toContain("Not executed");
		expect(text).toContain("windows_vitest=skipped");
	});
});

// #3926 root-cause witness: reproduces the refspec-form mechanism against the
// real `git` binary through the registered `git-fixture-env` seam. The local
// transport proves the form difference (by-name fails after the ref is
// deleted; by-captured-SHA resolves the object); GitHub's own server-side
// policy is established by the same-run, same-second sibling successes in
// INVESTIGATION.md.
describe("#3926 the merge ref disappears but the captured commit resolves", () => {
	const fixture = setupTestEnvironment("pi-lens-3926-git-");
	afterAll(() => fixture.cleanup());

	it("fails the by-name fetch and succeeds the by-captured-SHA fetch", () => {
		const gitconfig = resolve(fixture.tmpDir, "gitconfig");
		writeFileSync(
			gitconfig,
			"[user]\n\tname = pi-lens test\n\temail = test@example.com\n",
		);
		const git = (cwd: string, args: string[]): string =>
			gitExecFileSync("git", args, {
				cwd,
				encoding: "utf8",
				env: { GIT_CONFIG_GLOBAL: gitconfig },
			});

		const work = resolve(fixture.tmpDir, "work");
		const origin = resolve(fixture.tmpDir, "origin.git");
		mkdirSync(work, { recursive: true });
		git(work, ["init", "-q", "-b", "master"]);
		writeFileSync(resolve(work, "base.txt"), "base\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "base"]);
		const base = git(work, ["rev-parse", "HEAD"]).trim();

		git(work, ["checkout", "-q", "-b", "pr"]);
		writeFileSync(resolve(work, "head.txt"), "head\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "head"]);
		const head = git(work, ["rev-parse", "HEAD"]).trim();

		// The base advances independently, so the test merge is a real two-parent
		// commit with no parent reachable through the PR head.
		git(work, ["checkout", "-q", "master"]);
		writeFileSync(resolve(work, "main.txt"), "main\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "main advance"]);
		const main = git(work, ["rev-parse", "HEAD"]).trim();

		git(work, ["merge", "--no-ff", "-q", "-m", "test merge", "pr"]);
		const merge = git(work, ["rev-parse", "HEAD"]).trim();
		expect(
			[base, head, main, merge].every((sha) => /^[0-9a-f]{40}$/.test(sha)),
		).toBe(true);
		expect(new Set([base, head, main, merge]).size).toBe(4);

		git(work, ["checkout", "-q", "master"]);
		git(work, ["reset", "-q", "--hard", main]);
		git(work, ["update-ref", "refs/pull/7/head", head]);
		git(work, ["update-ref", "refs/pull/7/merge", merge]);
		git(fixture.tmpDir, ["init", "-q", "--bare", origin]);
		git(work, [
			"push",
			"-q",
			origin,
			"refs/heads/master:refs/heads/master",
			"refs/pull/7/head:refs/pull/7/head",
			"refs/pull/7/merge:refs/pull/7/merge",
		]);

		// The merge commit is now reachable only through the mutable ref that the
		// merge deletes. A clone after the deletion does not carry the object.
		git(origin, ["update-ref", "-d", "refs/pull/7/merge"]);
		const consumer = resolve(fixture.tmpDir, "consumer");
		git(fixture.tmpDir, ["clone", "-q", "--no-local", origin, consumer]);

		const byName = (() => {
			try {
				git(consumer, [
					"fetch",
					"origin",
					"+refs/pull/7/merge:refs/remotes/pull/7/merge",
				]);
				return "succeeded";
			} catch (error) {
				return String((error as { stderr?: Buffer | string }).stderr ?? error);
			}
		})();
		expect(byName).toContain("couldn't find remote ref refs/pull/7/merge");

		expect(() =>
			git(consumer, ["fetch", "origin", `+${merge}:refs/remotes/pull/7/b1`]),
		).not.toThrow();
		expect(git(consumer, ["rev-parse", "refs/remotes/pull/7/b1"]).trim()).toBe(
			merge,
		);
	});
});
