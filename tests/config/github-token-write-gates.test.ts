import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import {
	scannableRegions,
	splitSegments,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = { uses?: unknown; run?: unknown; env?: unknown; with?: unknown };
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

// A `gh` call resolves its repository from one of three sources: `GH_REPO` (at
// workflow, job or step scope), the checkout's git remote, or its own
// `-R`/`--repo` (for `gh api`, the repository in the request path). A call that
// offers none dies where it writes, with
// `failed to run git: fatal: not a git repository`.
//
// #4382 named that on the push lane, where the fix removed the wrong PR number.
// Its PR-lane sibling stayed: `finalize-rerun` has no checkout and no `GH_REPO`,
// so run 38956598286 (2026-10-16, attempt 2 green) failed in "Swap terminal
// rerun labels" and the terminal verdict label was never swapped. Six of six
// runs that reached that write failed the same way, the first on 2026-10-10
// (run 38459454960), so the defect predates #4386 and is not a regression of it.
//
// The census derives its population from shell STRUCTURE, not from a regex over
// job text (AGENTS.md shape 69: an enumerated spelling list passes every
// spelling it does not know). Each `run:` script is lexed by the shared shell
// lexer `scripts/hooks/guard-bash.mjs` exports -- the one the Bash guard runs --
// rather than by a hand-rolled line filter, so:
//   - a comment cannot create a call, and a quoted example is ONE opaque word,
//     so prose can neither issue a call nor satisfy an exemption (F1);
//   - a `\`-continued command is one command, a `$( … )` body is a script of
//     its own, `bash -c '<script>'` and `eval '<script>'` are scanned as the
//     script they run, and a command word resolves through the workflow's own
//     declared env, so an alias, an absolute path and a write verb are all
//     `gh` wherever they sit (F2);
//   - every invocation is judged on its own, so one call's `-R` cannot excuse a
//     later call (F3).
// A shape the census cannot classify -- an unresolvable command word, `gh`
// outside command position (an unmodelled wrapper), a non-shell step that names
// `gh` -- is REPORTED, never skipped, so the gate fails closed.

/** Shell interpreters whose `-c` argument is itself a script bash runs. */
const SHELL_COMMANDS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
/** `eval`'s arguments are a script too. */
const EVAL_COMMAND = "eval";
/** One variable reference as a whole word: `$GH_BIN`, `${GH_BIN}`. */
const VARIABLE_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** `gh api` names its repository in the request path. */
const API_REPO_PATH =
	/(?:^|[\s/])repos\/(?:\$GITHUB_REPOSITORY|\$\{\{\s*github\.repository\s*\}\}|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\//;

type GhInvocation = {
	/** 0-based index of the step whose `run:` script holds the call. */
	step: number;
	/** The simple command that runs `gh`, quotes and comments stripped. */
	words: string[];
};

type Census = {
	invocations: GhInvocation[];
	/** Shapes the census cannot classify: reported, never skipped. */
	unclassified: Array<{ step: number; detail: string }>;
};

type Finding = {
	job: string;
	kind: "missing-source" | "unclassified";
	detail: string;
};

/** The final path segment of a word, so `/usr/bin/gh` reads as `gh`. */
function commandName(word: string): string {
	const cut = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
	return cut === -1 ? word : word.slice(cut + 1);
}

function declaredEnv(...scopes: unknown[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const scope of scopes) {
		if (typeof scope !== "object" || scope === null) continue;
		for (const [key, value] of Object.entries(
			scope as Record<string, unknown>,
		)) {
			if (value === undefined || value === null) continue;
			env[key] = String(value);
		}
	}
	return env;
}

/** A `GH_REPO` that holds a value; `GH_REPO: ""` is no source. */
function declaredGhRepo(scope: unknown): string {
	if (typeof scope !== "object" || scope === null) return "";
	const value = (scope as Record<string, unknown>).GH_REPO;
	return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Resolve a command word to `gh`, to another command, or to "cannot read it"
 * -- an undeclared alias, or an alias whose value is a runtime expression.
 */
function resolveCommand(
	word: string,
	env: Record<string, string>,
): "gh" | "other" | "unresolved" {
	if (commandName(word) === "gh") return "gh";
	const variable = VARIABLE_WORD.exec(word);
	if (!variable) return "other";
	const value = env[variable[1]]?.trim();
	if (value === undefined || value === "") return "unresolved";
	const [first] = value.split(/\s+/);
	if (first === undefined || first.includes("${{")) return "unresolved";
	return commandName(first) === "gh" ? "gh" : "other";
}

function isCheckoutStep(step: Step): boolean {
	return /^actions\/checkout@/.test(String(step.uses));
}

/**
 * A non-shell executor can still run `gh` (`exec.exec('gh pr edit …')` in a
 * github-script step). The census models shell scripts only, so it reports
 * that step instead of skipping it.
 */
function namesGhCommand(step: Step): boolean {
	return /(?:^|[\s"'`;&|(])gh\s/.test(JSON.stringify(step.with ?? ""));
}

/**
 * Does this `gh` command need a repository? `gh auth` and `gh --version` do
 * not; `gh api` names one in its request path. Every other verb does, including
 * the verbs no census enumerated (`gh variable set`, `gh secret set`).
 */
function needsRepository(words: string[]): boolean {
	const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
	if (subcommand === undefined || subcommand === "auth") return false;
	if (subcommand === "api") {
		return !API_REPO_PATH.test(words.slice(1).join(" "));
	}
	return true;
}

/** Is this a repository operand a live `gh` accepts? `""` is not. */
function isRepoValue(value: string | undefined): boolean {
	return value !== undefined && value !== "" && !value.startsWith("-");
}

/** `-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`. */
function hasRepoOperand(words: string[]): boolean {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "-R" || word === "--repo")
			return isRepoValue(words[index + 1]);
		if (word.startsWith("--repo=")) {
			return isRepoValue(word.slice("--repo=".length));
		}
		if (word.startsWith("-R") && word.length > 2) {
			return isRepoValue(word.slice(2));
		}
	}
	return false;
}

function scanScript(
	script: string,
	step: number,
	env: Record<string, string>,
	census: Census,
): void {
	// Index 0 is the script itself; the rest are command-substitution bodies,
	// which bash also executes.
	for (const region of scannableRegions(script)) {
		for (const segment of splitSegments(region)) {
			classifySegment(splitWords(segment), step, env, census);
		}
	}
}

function classifySegment(
	rawWords: string[],
	step: number,
	env: Record<string, string>,
	census: Census,
): void {
	const { env: assigned, rest } = stripEnvAssignments(rawWords);
	if (rest.length === 0) return;
	const scope = { ...env, ...assigned };
	const command = commandName(rest[0]);
	if (SHELL_COMMANDS.has(command)) {
		const flag = rest.findIndex(
			(word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
		);
		const nested = flag < 0 ? undefined : rest[flag + 1];
		// `bash ci.sh` runs a file this census does not read; `bash -c '<script>'`
		// runs a script it can.
		if (nested !== undefined) scanScript(nested, step, scope, census);
		return;
	}
	if (command === EVAL_COMMAND) {
		scanScript(rest.slice(1).join(" "), step, scope, census);
		return;
	}
	const resolution = resolveCommand(rest[0], scope);
	if (resolution === "unresolved") {
		// A lone unresolvable word is not a call the census can judge: every
		// repository-needing `gh` verb carries at least its subject, and the
		// shared lexer also hands back array elements (`HOST_PKGS+=("$pkg")`
		// lexes as the segment `"$pkg"`) and other parenthesised fragments.
		// With an argument list in hand there is a verb to read, so an alias
		// the workflow never declared is reported rather than skipped.
		if (rest.length < 2) return;
		census.unclassified.push({
			step,
			detail: `the command word \`${rest[0]}\` cannot be resolved`,
		});
		return;
	}
	if (resolution === "gh") {
		census.invocations.push({ step, words: rest });
		return;
	}
	if (rest.slice(1).some((word) => commandName(word) === "gh")) {
		census.unclassified.push({
			step,
			detail: `\`gh\` is an argument of \`${rest[0]}\`, not the command`,
		});
	}
}

function censusWorkflow(workflow: Workflow): {
	findings: Finding[];
	population: string[];
} {
	const findings: Finding[] = [];
	const population: string[] = [];
	const workflowEnv = declaredEnv(workflow.env);
	for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
		const census: Census = { invocations: [], unclassified: [] };
		const jobEnv = declaredEnv(job.env);
		let checkoutBefore = false;
		let named = false;
		const steps = (job.steps ?? []) as Step[];
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index];
			const env = { ...workflowEnv, ...jobEnv, ...declaredEnv(step.env) };
			// `GH_REPO` in step scope counts (the placement cache-prune.yml
			// already uses); a checkout counts only from a step BEFORE this one.
			const sourced =
				[workflow.env, job.env, step.env].some(
					(scope) => declaredGhRepo(scope) !== "",
				) || checkoutBefore;
			if (typeof step.run === "string") {
				const calls = census.invocations.length;
				const problems = census.unclassified.length;
				scanScript(step.run, index, env, census);
				for (const invocation of census.invocations.slice(calls)) {
					named = true;
					if (!needsRepository(invocation.words)) continue;
					if (sourced || hasRepoOperand(invocation.words)) continue;
					findings.push({
						job: key,
						kind: "missing-source",
						detail: `step ${index + 1}: \`${invocation.words.join(" ")}\``,
					});
				}
				for (const problem of census.unclassified.slice(problems)) {
					named = true;
					findings.push({
						job: key,
						kind: "unclassified",
						detail: `step ${index + 1}: ${problem.detail}`,
					});
				}
			} else if (namesGhCommand(step)) {
				named = true;
				findings.push({
					job: key,
					kind: "unclassified",
					detail: `step ${index + 1}: a non-shell step names \`gh\``,
				});
			}
			if (isCheckoutStep(step)) checkoutBefore = true;
		}
		if (named) population.push(key);
	}
	return { findings, population };
}

const BARE_GH_WRITE = "gh pr edit 4550 --add-label ci:real";

/** A one-job workflow driving the same census the workflow tree runs. */
function probe(options: {
	run: string;
	workflowEnv?: Record<string, string>;
	jobEnv?: Record<string, string>;
	stepEnv?: Record<string, string>;
	checkout?: boolean;
}): { findings: Finding[]; population: string[] } {
	const steps: Step[] = [];
	if (options.checkout) steps.push({ uses: "actions/checkout@v7" });
	steps.push({ env: options.stepEnv, run: options.run });
	return censusWorkflow({
		env: options.workflowEnv,
		jobs: { probe: { env: options.jobEnv, steps } },
	});
}

function findingsOf(workflow: Workflow): Array<[string, string]> {
	return censusWorkflow(workflow).findings.map((finding) => [
		finding.job,
		finding.kind,
	]);
}

function loaded(...lines: string[]): Workflow {
	return yaml.load(lines.join("\n")) as Workflow;
}

describe("workflow gh calls resolve a repository (#4382)", () => {
	it("gives every gh invocation in every workflow a repository source", () => {
		const findings: string[] = [];
		const population: string[] = [];
		for (const name of readdirSync(WORKFLOWS).sort()) {
			if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
			const { workflow } = load(resolve(WORKFLOWS, name));
			const census = censusWorkflow(workflow);
			population.push(...census.population.map((job) => `${name}:${job}`));
			findings.push(
				...census.findings.map(
					(finding) =>
						`${name}:${finding.job} (${finding.kind}: ${finding.detail})`,
				),
			);
		}
		// The census derives its population from structure; an empty derivation
		// must fail rather than read as a clean tree.
		assertNonEmptyScan("workflow gh census", population.length, 12);
		expect(
			findings,
			"a gh call with no GH_REPO, checkout, or -R dies on repo resolution",
		).toEqual([]);
	});

	it("flags the pre-fix finalize-rerun job shape, naming the job", () => {
		// Reject twin: the nearest wrong shape -- a gh write with no repository
		// source -- must stay visible, and the record must name the job.
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  finalize-rerun:",
				"    runs-on: ubuntu-latest",
				"    env:",
				"      GH_TOKEN: secret",
				"    steps:",
				"      - run: |",
				`          ${BARE_GH_WRITE}`,
				"  classify:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v7",
				`      - run: ${BARE_GH_WRITE}`,
			),
		);
		expect(census.findings.map((finding) => finding.job)).toEqual([
			"finalize-rerun",
		]);
		expect(census.findings[0]?.kind).toBe("missing-source");
		expect(census.findings[0]?.detail).toContain(BARE_GH_WRITE);
		expect(census.population).toEqual(["finalize-rerun", "classify"]);
	});

	it("does not read a commented-out gh call as one", () => {
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  docs:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: |",
				"          # gh pr edit 4550 --add-label ci:real",
				"          echo hello",
			),
		);
		expect(census.findings).toEqual([]);
		expect(census.population).toEqual([]);
	});

	it("does not let a comment or a quoted example supply the repository", () => {
		// F1, both directions: prose cannot ISSUE a call, and prose cannot
		// satisfy an exemption either. The comment below is the line a
		// maintainer would write to document the job's own -R flag.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  trailing-comment:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					`          ${BARE_GH_WRITE}  # e.g. -R owner/repo`,
					"  quoted-example:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					'          echo "reminder: use -R owner/repo when you run gh pr edit"',
					`          ${BARE_GH_WRITE}`,
				),
			),
		).toEqual([
			["trailing-comment", "missing-source"],
			["quoted-example", "missing-source"],
		]);
	});

	it("classifies every gh invocation shape the shell offers", () => {
		// F2: the gate is green only if it sees EVERY spelling, so each plant
		// here is a real call with no repository source and must be a finding.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  alias:",
					"    runs-on: ubuntu-latest",
					"    env:",
					"      GH_BIN: gh",
					"    steps:",
					`      - run: $GH_BIN${BARE_GH_WRITE.slice(2)}`,
					"  absolute-path:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: /usr/bin/${BARE_GH_WRITE}`,
					"  nested-shell:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: bash -c '${BARE_GH_WRITE}'`,
					"  evaluated:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: eval '${BARE_GH_WRITE}'`,
					"  continued:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					"          gh \\",
					"            pr edit 4550 --add-label ci:real",
					"  unlisted-verb:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: gh variable set FOO --body bar",
				),
			),
		).toEqual([
			["alias", "missing-source"],
			["absolute-path", "missing-source"],
			["nested-shell", "missing-source"],
			["evaluated", "missing-source"],
			["continued", "missing-source"],
			["unlisted-verb", "missing-source"],
		]);
	});

	it("reports an invocation shape it cannot classify", () => {
		// Fail closed: a shape the census cannot read is a finding, never a skip.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  undeclared-alias:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: $GH_BIN pr edit 4550 --add-label ci:real",
					"  wrapped:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: timeout 30 ${BARE_GH_WRITE}`,
					"  non-shell:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - uses: actions/github-script@v7",
					"        with:",
					"          script: |",
					`            exec.exec('${BARE_GH_WRITE}')`,
				),
			),
		).toEqual([
			["undeclared-alias", "unclassified"],
			["wrapped", "unclassified"],
			["non-shell", "unclassified"],
		]);
	});

	it("judges each call, so one call's -R does not excuse another", () => {
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  mixed:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: |",
				"          gh pr view 9999 -R owner/repo",
				"          gh pr edit 9999 --add-label x",
			),
		);
		expect(census.findings).toEqual([
			{
				job: "mixed",
				kind: "missing-source",
				detail: "step 1: `gh pr edit 9999 --add-label x`",
			},
		]);
	});

	it("accepts a workflow-scope GH_REPO", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				workflowEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts a job-scope GH_REPO", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				jobEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts a step-scope GH_REPO, the placement cache-prune.yml uses", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				stepEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts -R and --repo operands", () => {
		for (const operand of [
			"-R owner/repo",
			"--repo owner/repo",
			"--repo=owner/repo",
		]) {
			expect(
				probe({ run: `${BARE_GH_WRITE} ${operand}` }).findings,
				operand,
			).toEqual([]);
		}
	});

	it("accepts a gh api call that names its repository in the path", () => {
		for (const call of [
			"gh api repos/owner/repo/issues/1 --method PATCH -f body=hi",
			'gh api "/repos/$GITHUB_REPOSITORY/issues/1" --method PATCH -f body=hi',
		]) {
			expect(probe({ run: call }).findings, call).toEqual([]);
		}
	});

	it("accepts a checkout that lands before the call", () => {
		expect(probe({ run: BARE_GH_WRITE, checkout: true }).findings).toEqual([]);
	});

	it("does not accept a checkout that lands after the call", () => {
		const census = censusWorkflow({
			jobs: {
				probe: {
					steps: [{ run: BARE_GH_WRITE }, { uses: "actions/checkout@v7" }],
				},
			},
		});
		expect(census.findings.map((finding) => finding.kind)).toEqual([
			"missing-source",
		]);
	});

	it("does not accept an empty repository source", () => {
		for (const run of [
			`${BARE_GH_WRITE} --repo ""`,
			`${BARE_GH_WRITE} --repo=`,
		]) {
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["missing-source"]);
		}
		expect(
			probe({ run: BARE_GH_WRITE, jobEnv: { GH_REPO: "" } }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("keeps repository-independent commands out of the findings", () => {
		expect(probe({ run: "gh auth status" }).findings).toEqual([]);
		expect(probe({ run: "gh --version" }).findings).toEqual([]);
		// They are still in the population: the census read them, it just found
		// nothing to require.
		expect(probe({ run: "gh auth status" }).population).toEqual(["probe"]);
	});

	it("keeps a job with no gh call out of the population", () => {
		expect(probe({ run: "echo hello" })).toEqual({
			findings: [],
			population: [],
		});
	});
});
