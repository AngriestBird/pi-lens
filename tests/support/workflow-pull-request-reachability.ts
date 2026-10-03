/**
 * Shared owner of the "can a pull request run this job" model (#3043, #3087,
 * #3941). One module, because two sweeps ask the same question in opposite
 * directions and a second copy is exactly how they drift apart:
 *
 * - `tests/config/workflow-pull-request-reachability.test.ts` (#3043/#3087)
 *   enumerates every job-level `if:` in a pull_request-triggerable workflow
 *   and flags the ones a pull request can NEVER satisfy.
 * - `tests/config/heavy-advisory-gate-workflow.test.ts` (#3941) classifies each
 *   checkout site's stage and asks whether a job's `if:` PROVES it can never
 *   run on a pull request, so its checkout cannot be an early-start advisory
 *   one. That consumer is `provesNotPullRequestEligible` at the bottom, built
 *   on this module's expression syntax handling so the two never fork.
 *
 * EVALUATION: the same technique as tests/config/ci-infra-kill-rerun-gate.ts
 * and install-smoke-gates.ts -- yaml.load the REAL workflow, substitute every
 * context path in the LOADED `if:` string with a JSON literal, and evaluate
 * with `new Function`. GitHub Actions expression syntax and JS agree exactly
 * on this subset (dotted paths, `==`, `!=`, `&&`, `||`, parentheses, quoted
 * strings and numbers). An unrecognised context path THROWS rather than
 * being guessed at, so a workflow that grows a new one fails loudly instead of
 * being silently read as reachable.
 *
 * THE MODEL, and what it cannot see. Reachability is decided against a small
 * declared set of pull_request contexts (PR_CONTEXTS below) -- a job is
 * reachable if ANY of them makes its `if:` true. `needs.*.result` reads
 * `success` and `needs.*.outputs.*` reads `'true'`, the permissive reading:
 * a job that is reachable only when an upstream job FAILS will read as
 * unreachable and needs a registry entry naming that. A job's
 * `strategy.matrix` is evaluated under the same contexts (#3085 gap 2); the
 * matrix helpers live in the reachability test, which imports this model.
 * One known blind spot, stated rather than papered over: a workflow with no
 * `pull_request`/`pull_request_target` trigger at all is out of scope -- the
 * nightly-only lanes (tool-smoke, compat-smoke, parser-smoke, release,
 * labels, ...) are deliberate, and flagging every job in them would bury the
 * sweep's real signal in a registry nobody reads (#3085 gap 1).
 */
import yaml from "../../clients/deps/js-yaml.js";

export interface PullRequestContext {
	label: string;
	eventName: string;
	action: string;
	merged: boolean;
}

// A job is PR-reachable if ANY of these makes its `if:` true. Two rows,
// because one cannot serve both: `clear-stale-verdict-labels` requires
// action `synchronize`, and a job restricted to other actions (as
// `pr-body-lint` was before #3864 F2) needs a non-synchronize row; both kinds
// are genuinely PR-reachable.
export const PR_CONTEXTS: readonly PullRequestContext[] = [
	{
		label: "pull_request / opened",
		eventName: "pull_request",
		action: "opened",
		merged: false,
	},
	{
		label: "pull_request / synchronize",
		eventName: "pull_request",
		action: "synchronize",
		merged: false,
	},
];

const CONTEXT_PATHS: Array<[string, (ctx: PullRequestContext) => unknown]> = [
	["github.event_name", (ctx) => ctx.eventName],
	["github.event.action", (ctx) => ctx.action],
	["github.event.pull_request.merged", (ctx) => ctx.merged],
	// Same-repo PR by a human: the common case, and the permissive one for
	// every fork / bot guard in the tree.
	["github.event.pull_request.head.repo.full_name", () => "acme/repo"],
	["github.event.pull_request.user.login", () => "a-human"],
	["github.repository", () => "acme/repo"],
	// A `pull_request` event carries no workflow_run payload at all, so every
	// path under it reads null -- which is what makes a workflow_run-only job
	// correctly unreachable from a PR.
	["github.event.workflow_run.head_repository.full_name", () => null],
	["github.event.workflow_run.head_branch", () => null],
	["github.event.workflow_run.conclusion", () => null],
	["github.event.workflow_run.run_attempt", () => null],
	["github.event.workflow_run.event", () => null],
];

// Zero-argument status functions and the permissive `needs.*` reading. Order
// matters only in that these run before the leftover-reference check.
const FUNCTION_SUBSTITUTIONS: Array<[RegExp, string]> = [
	[/always\(\)/g, "true"],
	[/success\(\)/g, "true"],
	[/failure\(\)/g, "false"],
	[/cancelled\(\)/g, "false"],
	[/needs\.[A-Za-z0-9_-]+\.result/g, '"success"'],
	[/needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+/g, '"true"'],
];

/**
 * `${{ ... }}` is optional around a job-level `if:`; release.yml writes it
 * that way. Strip it before evaluating or projecting either spelling. Shared
 * by `substituteForPullRequest` and the event-name projection below so the two
 * cannot disagree about what counts as the expression body.
 */
function expressionBody(expr: string): string {
	return expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
}

/**
 * Normalize GitHub's `==`/`!=` to JS strict forms for `new Function`. `!=`/`==`
 * before `===`, so the `!==` produced here is not re-rewritten; the character
 * class keeps `>=`/`<=` untouched.
 */
function completedComparisons(out: string): string {
	return out.replace(/!=/g, "!==").replace(/(?<![!<>=])==(?!=)/g, "===");
}

export function substituteForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): string {
	let out = expressionBody(expr);
	for (const [path, read] of CONTEXT_PATHS) {
		out = out.split(path).join(JSON.stringify(read(ctx)) ?? "null");
	}
	for (const [pattern, replacement] of FUNCTION_SUBSTITUTIONS) {
		out = out.replace(pattern, replacement);
	}
	if (/(?:github|needs|env|inputs|steps|vars|secrets)\./.test(out)) {
		throw new Error(
			`workflow-pull-request-reachability: unrecognised context path in an if: expression -- ` +
				`add it to CONTEXT_PATHS with the value a pull_request run would see, rather than ` +
				`letting it be guessed at. Residue: ${out}`,
		);
	}
	return completedComparisons(out);
}

/**
 * Evaluate a workflow expression under one PR context. `fromJSON` is the one
 * function a matrix narrowing uses, and it is JSON.parse.
 */
export function evaluateForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): unknown {
	const substituted = substituteForPullRequest(expr, ctx);
	// `new Function` over this repo's own workflow text plus JSON-literal
	// fixtures, never external or untrusted input -- the same argument
	// tests/config/ci-infra-kill-rerun-gate.test.ts makes for the same
	// technique.
	return new Function("fromJSON", `"use strict"; return (${substituted});`)(
		(text: string) => JSON.parse(text),
	);
}

export function isTrueForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): boolean {
	return Boolean(evaluateForPullRequest(expr, ctx));
}

export function isPullRequestReachable(expr: string): boolean {
	return PR_CONTEXTS.some((ctx) => isTrueForPullRequest(expr, ctx));
}

export interface WorkflowFile {
	/** `.github/workflows/<name>.yml`, the registry key prefix. */
	path: string;
	text: string;
}

type Job = {
	if?: unknown;
	name?: unknown;
	"continue-on-error"?: unknown;
	strategy?: { matrix?: unknown };
};
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

export function loadWorkflow(text: string): Workflow {
	// `on:` is YAML 1.1 truthy, so js-yaml can key it as boolean `true`.
	const parsed = yaml.load(text) as Record<string, unknown>;
	const triggers = parsed?.on ?? parsed?.[true as unknown as string];
	return { on: triggers, jobs: parsed?.jobs as Record<string, Job> };
}

export function triggersOnPullRequest(workflow: Workflow): boolean {
	const triggers = workflow.on;
	// GitHub accepts three spellings of `on:` and this must read all three.
	// The ARRAY case is checked first and explicitly (round 2, F1): an array
	// is `typeof "object"`, so the mapping branch below would key it with
	// Object.keys and get ["0","1"] -- no match, and every job in that file
	// silently skipped with jobsExamined 0, the sweep reading clean over a
	// file it never looked inside. Every workflow in the tree happens to use
	// the mapping form today, which is exactly why this read clean; the
	// sweep exists for the next member, which may use any spelling.
	const names = Array.isArray(triggers)
		? triggers.map(String)
		: typeof triggers === "string"
			? [triggers]
			: triggers && typeof triggers === "object"
				? Object.keys(triggers as Record<string, unknown>)
				: [];
	return names.some(
		(name) => name === "pull_request" || name === "pull_request_target",
	);
}

// ── #3941 event-only exclusion projection ──────────────────────────────────

/**
 * Every GitHub event whose `github.event_name` still carries a pull request:
 * the fork-safe `pull_request` and the base-checkout `pull_request_target`. A
 * condition true for EITHER is not proven excluded.
 */
const PULL_REQUEST_EVENT_NAMES = [
	"pull_request",
	"pull_request_target",
] as const;

/**
 * Substitute ONLY the `github.event_name` axis, leaving every other context
 * path for `new Function` to reject. Built on the shared `expressionBody` /
 * `completedComparisons` so it reads the same expression the reachability
 * model reads, without re-deriving GitHub's `${{ }}` and `==`/`!=` syntax.
 */
function substituteEventName(expr: string, eventName: string): string {
	const body = expressionBody(expr)
		.split("github.event_name")
		.join(JSON.stringify(eventName));
	return completedComparisons(body);
}

/**
 * Does this job-level `if:` PROVE the job never runs on a pull request?
 *
 * The reachability model above reads a `pull_request` run as one of two
 * opened/synchronize contexts. A `false` from it is NOT proof of exclusion:
 * `failure()` may hold, GitHub sends actions those two rows do not name, and
 * `pull_request_target` is a pull request event whose `github.event_name` is
 * not `pull_request`. So this projection substitutes ONLY the event-name axis
 * and lets every other context path fall through to `new Function`'s
 * ReferenceError, which is caught and read as UNPROVEN. That is the
 * conservative direction required for a guard: an unproven condition stays
 * eligible (stage A/C), so the #3941 rule keeps guarding a real checkout
 * rather than losing it (AGENTS.md shape 48).
 *
 * True only when the expression names `github.event_name` and is false for
 * every pull request event name, with no other context path involved. A
 * condition that merely shares a line with an unknown path
 * (`… == 'schedule' || github.event.issue.number == 1`) throws on that path
 * and reads as unproven, never as excluded.
 */
export function provesNotPullRequestEligible(expr: unknown): boolean {
	if (typeof expr !== "string" || !expr.includes("github.event_name")) {
		return false;
	}
	try {
		return PULL_REQUEST_EVENT_NAMES.every((eventName) => {
			const projected = substituteEventName(expr, eventName);
			return !new Function(`"use strict"; return (${projected});`)();
		});
	} catch {
		return false;
	}
}
