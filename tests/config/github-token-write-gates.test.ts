import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import {
	commandBasename,
	stripCommandGroupAndRunnerPrefixes,
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
// `gh`, and an inline script the lexer cannot open (a heredoc handed to a shell,
// a script piped or substituted into one, `su -c`, `node -e`, `python -c`) -- is
// REPORTED as `unclassified`, never skipped, so the gate fails closed.
//
// Environment is the script's own, the model the Bash guard's `classifySegment`
// keeps in its `sharedEnv`: workflow < job < step < a preceding standalone or
// `export`ed assignment < the command's own inline prefix. A variable the
// Actions runner defines itself is non-empty by rule, so `--repo
// "$GITHUB_REPOSITORY"` resolves in a checkout-free job (the shape #4382 is
// about), while a workflow-declared `""` still clears it and any other
// undeclared variable still expands to nothing.
//
// Stated limits of a source census: a shell that runs a FILE (`bash ci.sh`) or
// remote input (`curl … | sh`) is not read, a heredoc handed to a NON-shell
// interpreter (`node <<'NODE'`, `python3 - <<'PY'`) is not read, an inline
// `-c`/`-e` payload that does not itself name a `gh` call is not reported, and
// an earlier `echo GH_REPO=… >> $GITHUB_ENV` is not tracked.

/** Shell interpreters whose `-c` argument is itself a script bash runs. */
const SHELL_COMMANDS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
/** `eval`'s arguments are a script too. */
const EVAL_COMMAND = "eval";
/** Flags through which a non-shell executor is handed its program as a string. */
const SCRIPT_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--print"]);
/** One variable reference as a whole word: `$GH_BIN`, `${GH_BIN}`. */
const VARIABLE_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/**
 * A `gh` command word inside opaque text -- a script string, a JSON payload, a
 * quoted argument. `gh` alone is not one: a call carries its subject, so the
 * word boundary is what tells a call from the command word itself.
 */
const GH_COMMAND_WORD = /(?:^|[\s"'`;&|(])gh\s/;
/** A repository root as `gh api` names one, or the GraphQL endpoint. */
const API_REPOSITORY_ROOT =
	/^(?:graphql|\/?repos\/(?:\$GITHUB_REPOSITORY|\$\{\{\s*github\.repository\s*\}\}|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/|$))/;
/**
 * Variables the Actions runner defines itself, before any `run:` script. A
 * repository operand built from one is a source even with no checkout.
 */
const RUNNER_PROVIDED_VARIABLE = /^(?:GITHUB|RUNNER)_[A-Z0-9_]+$/;
type GhInvocation = {
	/** 0-based index of the step whose `run:` script holds the call. */
	step: number;
	/** The simple command that runs `gh`, quotes and comments stripped. */
	words: string[];
	env: Record<string, string>;
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

/**
 * Resolve a command word to the command it runs, and whether the census could
 * read it at all -- an undeclared alias, or an alias whose value is a runtime
 * expression. Command POSITION belongs to the Bash guard, so every arm shares
 * one alias model: a declared `SHELLX=bash` runs a shell wherever `bash` would.
 */
function resolveCommand(
	word: string,
	env: Record<string, string>,
): { command: string; unresolved: boolean } {
	const variable = VARIABLE_WORD.exec(word);
	if (!variable) {
		const command = commandBasename(word);
		return { command, unresolved: command.includes("$") };
	}
	const value = env[variable[1]]?.trim();
	if (value === undefined || value === "") {
		return { command: word, unresolved: true };
	}
	const [first] = value.split(/\s+/);
	if (first === undefined || first.includes("${{")) {
		return { command: word, unresolved: true };
	}
	return { command: commandBasename(first), unresolved: false };
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
	return GH_COMMAND_WORD.test(JSON.stringify(step.with ?? ""));
}

/**
 * A variable's value at the live `gh` boundary, in its three states: declared
 * by the workflow (its value, `""` included); never declared but supplied by
 * the Actions runner (`GITHUB_REPOSITORY` and the rest of that namespace,
 * non-empty by rule, so a checkout-free job is valid); or never declared and
 * not the runner's, which expands to nothing -- a typo or an unexported shell
 * variable, the state #4382's `--repo "$PATCH_REPO"` probe pins.
 */
function variableValue(
	name: string,
	env: Record<string, string>,
): string | undefined {
	const declared = env[name];
	if (declared !== undefined) return declared;
	return RUNNER_PROVIDED_VARIABLE.test(name) ? "runner-provided" : undefined;
}

/**
 * The gh verb's index: the first word that is neither a flag nor a `--flag`
 * value. gh's global options (`--hostname github.com`, `--repo owner/repo`)
 * precede the verb, so a value sitting in an option's slot is not the verb.
 */
function ghVerbIndex(words: string[]): number {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word.startsWith("-")) {
			// A long option without `=` takes its value as the next word.
			if (word.startsWith("--") && !word.includes("=")) index++;
			continue;
		}
		return index;
	}
	return -1;
}

/**
 * Does this `gh` command need a repository? `gh auth` and `gh --version` do
 * not; `gh api` names one in its request path. Every other verb does, including
 * the verbs no census enumerated (`gh variable set`, `gh secret set`).
 */
function needsRepository(words: string[]): boolean {
	const verb = ghVerbIndex(words);
	if (verb < 0 || words[verb] === "auth") return false;
	if (words[verb] !== "api") return true;
	// The endpoint sits behind options and their values (`-X POST`, `-f k=v`,
	// `--paginate`), so the census asks whether ANY word after the verb names a
	// repository root or GraphQL instead of fixing a position.
	return !words.slice(verb + 1).some((word) => API_REPOSITORY_ROOT.test(word));
}

/** Is this a repository operand a live `gh` accepts? `""` is not. */
function isRepoValue(
	value: string | undefined,
	env: Record<string, string>,
): boolean {
	const expanded = (value ?? "")
		.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
			(_, braced, bare) => variableValue(braced ?? bare, env) ?? "",
		)
		.trim();
	return (
		expanded !== "" && expanded !== "${{ '' }}" && !expanded.startsWith("-")
	);
}

/** `-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`. */
function hasRepoOperand(words: string[], env: Record<string, string>): boolean {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "-R" || word === "--repo")
			return isRepoValue(words[index + 1], env);
		if (word.startsWith("--repo=")) {
			return isRepoValue(word.slice("--repo=".length), env);
		}
		if (word.startsWith("-R") && word.length > 2) {
			return isRepoValue(word.slice(2), env);
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
	// which bash also executes -- and which inherit what the script had set by
	// then, as the Bash guard's `findDeny` copies its own `sharedEnv`.
	const sharedEnv: Record<string, string> = { ...env };
	for (const [index, region] of scannableRegions(script).entries()) {
		const segments = splitSegments(region).map((segment) =>
			splitWords(segment),
		);
		// A shell reading its script from STDIN takes it from another argument in
		// THIS region (`printf … | bash`, `bash <(echo …)`). A heredoc body is
		// subtracted by the lexer, so that arm reports without this test.
		const regionNamesGhCall = segments.some((words) =>
			words.some((word) => GH_COMMAND_WORD.test(word)),
		);
		const regionEnv = index === 0 ? sharedEnv : { ...sharedEnv };
		for (const words of segments)
			classifySegment(words, step, regionEnv, census, regionNamesGhCall);
	}
}

function classifySegment(
	rawWords: string[],
	step: number,
	sharedEnv: Record<string, string>,
	census: Census,
	regionNamesGhCall: boolean,
): void {
	const { env: assigned, rest } = stripEnvAssignments(
		stripCommandGroupAndRunnerPrefixes(rawWords),
	);
	if (rest.length === 0) {
		// A standalone `VAR=val` sets it for the rest of the script, exactly as
		// the Bash guard's own `classifySegment` keeps it in `sharedEnv`.
		Object.assign(sharedEnv, assigned);
		return;
	}
	if (rest[0] === "export") {
		Object.assign(sharedEnv, stripEnvAssignments(rest.slice(1)).env);
		return;
	}
	const scope = { ...sharedEnv, ...assigned };
	// One resolution for every arm, so an alias cannot be a shell in one spelling
	// and a stranger in another (AGENTS.md shape 69).
	const resolved = resolveCommand(rest[0], scope);
	if (resolved.unresolved) {
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
	const command = resolved.command;
	// A heredoc body is subtracted from the regions before the census sees it, so
	// a segment that hands that body to a shell hides an unreadable script
	// (`bash <<EOF`, `sh <<EOF`, `timeout 30 bash <<EOF`). A heredoc handed to
	// anything else is data (`cat > f <<EOF`), which is not a script at all.
	const handedToShell = rest.slice(1).some((word) => /^<<-?/.test(word))
		? rest.find((word) =>
				SHELL_COMMANDS.has(resolveCommand(word, scope).command),
			)
		: undefined;
	if (handedToShell !== undefined) {
		census.unclassified.push({
			step,
			detail: `\`${handedToShell}\` reads its script from a heredoc body this census does not read`,
		});
		return;
	}
	if (SHELL_COMMANDS.has(command)) {
		const flag = rest.findIndex(
			(word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
		);
		const nested = flag < 0 ? undefined : rest[flag + 1];
		if (nested !== undefined) {
			// `bash -c '<script>'` runs a script the census can read.
			scanScript(nested, step, scope, census);
			return;
		}
		// Otherwise the script can only arrive from stdin: a pipe or a process
		// substitution, whose text sits in this same region.
		// `bash ci.sh` runs a FILE: a stated limit, not a body the census misses.
		if (
			rest.slice(1).some((word) => !word.startsWith("-") && !/^[<>]/.test(word))
		) {
			return;
		}
		// A bare `bash` reads stdin. Report it when this region names a `gh` call
		// (`printf … | bash`, `bash <(echo …)`), and stay silent for remote input
		// (`curl … | sh`), which is a stated limit rather than a modelled call.
		if (regionNamesGhCall) {
			census.unclassified.push({
				step,
				detail: `\`${rest[0]}\` reads its script from stdin, which names a \`gh\` call`,
			});
		}
		return;
	}
	if (command === EVAL_COMMAND) {
		scanScript(rest.slice(1).join(" "), step, scope, census);
		return;
	}
	if (command === "gh") {
		census.invocations.push({ step, words: rest, env: scope });
		return;
	}
	// A non-shell executor handed its program as a string: `su -c '<script>'`,
	// `node -e '<script>'`, `python3 -c '<script>'`. The census cannot run it, so
	// it reports the shape rather than reading the call as absent.
	const scriptFlag = rest.findIndex(
		(word, index) => index > 0 && SCRIPT_FLAGS.has(word),
	);
	if (scriptFlag >= 0 && GH_COMMAND_WORD.test(rest[scriptFlag + 1] ?? "")) {
		census.unclassified.push({
			step,
			detail: `\`${rest[0]} ${rest[scriptFlag]}\` runs a script this census does not read, and it names a \`gh\` call`,
		});
		return;
	}
	if (rest.slice(1).some((word) => commandBasename(word) === "gh")) {
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
			if (typeof step.run === "string") {
				const calls = census.invocations.length;
				const problems = census.unclassified.length;
				scanScript(step.run, index, env, census);
				for (const invocation of census.invocations.slice(calls)) {
					named = true;
					if (!needsRepository(invocation.words)) continue;
					if (
						checkoutBefore ||
						isRepoValue(invocation.env.GH_REPO, invocation.env) ||
						hasRepoOperand(invocation.words, invocation.env)
					)
						continue;
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
			"-Rowner/repo",
			"--repo owner/repo",
			"--repo=owner/repo",
		]) {
			expect(
				probe({ run: `${BARE_GH_WRITE} ${operand}` }).findings,
				operand,
			).toEqual([]);
		}
	});

	it("requires the value of an attached -R<slug> operand", () => {
		// R10: the attached branch is a branch of its own, not a spelling of the
		// spaced one -- an expansion that resolves to nothing is no source.
		expect(
			probe({ run: `${BARE_GH_WRITE} -R$PATCH_REPO` }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("counts a repository operand built from a runner variable", () => {
		// R8: the Actions runner defines GITHUB_REPOSITORY before any script runs,
		// so a checkout-free job that writes through it is valid -- the shape
		// labels.yml:sync uses on both of its calls.
		for (const options of [
			{ run: `${BARE_GH_WRITE} --repo "$GITHUB_REPOSITORY"` },
			{ run: `${BARE_GH_WRITE} -R "$GITHUB_REPOSITORY"` },
			{ run: BARE_GH_WRITE, jobEnv: { GH_REPO: "$GITHUB_REPOSITORY" } },
		]) {
			expect(probe(options).findings, JSON.stringify(options)).toEqual([]);
		}
	});

	it("keeps a declared empty runner variable empty", () => {
		// R8's third state: a nearer `""` still clears the runner's own value, so
		// the rule adds a source only where the workflow did not override it.
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo "$GITHUB_REPOSITORY"`,
				stepEnv: { GITHUB_REPOSITORY: "" },
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("carries an exported or standalone binding forward", () => {
		// R11: the Bash guard threads `export VAR=val` and a standalone `VAR=val`
		// into the rest of the script; the census keeps the same state.
		for (const run of [
			`export GH_REPO=owner/repo\n${BARE_GH_WRITE}`,
			`GH_REPO=owner/repo\n${BARE_GH_WRITE}`,
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
		expect(
			probe({
				run: `export GH_OTHER=owner/repo\n${BARE_GH_WRITE}`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
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

	it("judges shared command positions instead of rejecting valid shell", () => {
		// R1: command position belongs to guard-bash, including keywords.
		for (const prefix of [
			"if",
			"do",
			"{",
			"!",
			"exec",
			"env GH_TOKEN=x",
			"command",
			"sudo",
			"then",
			"time",
		]) {
			expect(
				probe({ run: `${prefix} ${BARE_GH_WRITE} -R owner/repo` }).findings,
				prefix,
			).toEqual([]);
			expect(
				probe({ run: `${prefix} ${BARE_GH_WRITE}` }).findings.map(
					(f) => f.kind,
				),
				prefix,
			).toEqual(["missing-source"]);
		}
		for (const run of [
			`for x in 1; do ${BARE_GH_WRITE} -R o/r; done`,
			`if ${BARE_GH_WRITE} -R o/r; then echo ok; fi`,
			`(${BARE_GH_WRITE} -R o/r)`,
			...["&&", "||", ";", "|"].map(
				(op) => `echo x ${op} ${BARE_GH_WRITE} -R o/r`,
			),
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("uses effective environment for each invocation", () => {
		// R2/R5: inline sources work; nearer empty bindings clear outer ones.
		for (const run of [
			`GH_REPO=owner/repo ${BARE_GH_WRITE}`,
			`bash -c 'GH_REPO=owner/repo ${BARE_GH_WRITE}'`,
			`env GH_REPO=owner/repo ${BARE_GH_WRITE}`,
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("honors nearer empty repository bindings", () => {
		// R5: an empty override removes the farther source.
		for (const options of [
			{ jobEnv: { GH_REPO: "" } },
			{ stepEnv: { GH_REPO: "" } },
			{ stepEnv: { GH_REPO: "${{ '' }}" } },
			{ run: `GH_REPO="" ${BARE_GH_WRITE}` },
		]) {
			expect(
				probe({
					run: BARE_GH_WRITE,
					workflowEnv: { GH_REPO: "owner/repo" },
					...options,
				}).findings.map((f) => f.kind),
			).toEqual(["missing-source"]);
		}
	});

	it("requires bound repository operands", () => {
		// R4: an unset shell operand is empty at the live gh boundary.
		const run = `${BARE_GH_WRITE} --repo "$PATCH_REPO"`;
		expect(probe({ run }).findings.map((f) => f.kind)).toEqual([
			"missing-source",
		]);
		expect(
			probe({ run, stepEnv: { PATCH_REPO: "owner/repo" } }).findings,
		).toEqual([]);
	});

	it("judges API endpoint shapes and placeholder requirements", () => {
		// R3: an endpoint root and GraphQL do not need cwd resolution.
		for (const run of [
			"gh api graphql -f query='{viewer{login}}'",
			"gh api repos/owner/repo --method PATCH -f x=y",
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
		expect(
			probe({ run: "gh api repos/{owner}/{repo}/issues/1" }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("finds the api endpoint behind its options", () => {
		// R3/Greptile P2: the endpoint is not always words[2] -- options and their
		// values sit in front of it, and gh's global options sit in front of the
		// verb. Live gh 2.100.0 accepts every call below.
		for (const run of [
			"gh api -X POST repos/owner/repo/issues -f title=x",
			"gh api --paginate graphql -f q=x",
			"gh --hostname github.com api graphql -f q=x",
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("reports unsupported default command expansion", () => {
		// R6: a runtime fallback must not silently leave the population.
		expect(
			probe({ run: "${GH_BIN:-gh} pr edit 4550 --add-label x" }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["unclassified"]);
	});

	it("reports an inline script the census cannot read", () => {
		// R9: each of these hands a `gh` write to an executor whose script text this
		// census cannot read. An empty population here reads as a clean workflow.
		for (const run of [
			`bash <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
			`sh <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
			`printf '%s\\n' '${BARE_GH_WRITE}' | bash`,
			`bash <(echo '${BARE_GH_WRITE}')`,
			`su -c '${BARE_GH_WRITE}'`,
			`node -e "require('node:child_process').execSync('${BARE_GH_WRITE}')"`,
			`python3 -c "import os; os.system('${BARE_GH_WRITE}')"`,
		]) {
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["unclassified"]);
		}
	});

	it("resolves a script command word through the workflow env", () => {
		// Shape 69, plant 1 (an alias): the shell in script position is named by a
		// workflow variable, and a wrapper puts the shell behind another word.
		for (const options of [
			{
				run: `$SHELLX <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
				jobEnv: { SHELLX: "bash" },
			},
			{ run: `timeout 30 bash <<'EOF'\n${BARE_GH_WRITE}\nEOF` },
		]) {
			expect(
				probe(options).findings.map((f) => f.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
	});

	it("does not read a config argument as a script", () => {
		// The flag family reports only a payload that itself names a `gh` call: a
		// `-c <file>` config argument is a file, not an inline program.
		expect(probe({ run: "npx oxlint -c .oxlintrc.json" }).findings).toEqual([]);
	});

	it("resolves a repository operand through a further binding", () => {
		// Shape 69, plant 3 (a value through another binding): the step binding is a
		// non-empty workflow expression, so the operand is a source either way.
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo "$REPO"`,
				stepEnv: { REPO: "$GITHUB_REPOSITORY" },
			}).findings,
		).toEqual([]);
	});

	it("leaves the stated limits silent", () => {
		// A shell running a FILE and remote input are the two shapes the census
		// deliberately does not read. Silence here is that limit, not a claim that
		// the file or the URL holds no `gh` call.
		for (const run of [
			"bash ci.sh",
			"curl -fsSL https://example.com/install.sh | sh",
		]) {
			expect(probe({ run }), run).toEqual({ findings: [], population: [] });
		}
	});

	it("keeps a shell file operand inside the stated limit", () => {
		// The limit has a boundary: `bash ci.sh` is not read, and it is not
		// reported either, even when the same region names a `gh` call. Reporting
		// it is the false positive a real workflow with no checkout would hit.
		expect(
			probe({
				run: `printf '%s\\n' '${BARE_GH_WRITE}' > ci.sh\nbash ci.sh`,
			}).findings,
		).toEqual([]);
	});

	it("keeps a job with no gh call out of the population", () => {
		expect(probe({ run: "echo hello" })).toEqual({
			findings: [],
			population: [],
		});
	});
});
