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
 * context path in the LOADED `if:` string with a JSON literal, evaluate with
 * `new Function`, and fold every comparison whose two operands are literals
 * through `githubEquals`, this module's one owner of GitHub's equality. GitHub
 * compares strings case-insensitively and coerces a mismatched type to a
 * number; JS strict equality does neither, so a bare `new Function`
 * UNDER-approximates GitHub truth and can read a real pull-request job as
 * unreachable. Folding keeps this a PARTIAL approximation: a comparison whose
 * operand is not a literal still runs under JS strict equality, which is the
 * model's stated residual -- the workflow population reaches none, because
 * every context path substitutes to a literal. An unrecognised context path
 * THROWS rather than being guessed at, so a workflow that grows a new one
 * fails loudly instead of being silently read as reachable.
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

/**
 * GitHub's equality, and the module's ONE owner of it (see EVALUATION above).
 * A string pair compares case-insensitively ("GitHub ignores case when
 * comparing strings"); a mismatched scalar pair coerces to a number
 * (`null`/`""` -> 0, `false` -> 0, `true` -> 1, any other non-numeric string
 * -> NaN), and NaN equals nothing -- including itself. This is the seam the
 * #3941 projection and the `substituteForPullRequest` fold both ask, so the
 * two cannot drift onto different comparison semantics.
 */
export function githubEquals(left: unknown, right: unknown): boolean {
	if (typeof left === "string" && typeof right === "string") {
		return left.toLowerCase() === right.toLowerCase();
	}
	return toGithubNumber(left) === toGithubNumber(right);
}

function toGithubNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value;
	if (typeof value === "string") return Number(value);
	return Number.NaN;
}

// A literal operand, as it appears in a substituted expression: a JSON string
// written by `JSON.stringify` for a context path, a workflow `'…'` string, a
// number, or a word literal. The lookarounds keep `true` from matching inside
// an identifier such as `isTrue`.
const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const NUMBER_LITERAL = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`;
const LITERAL = `(?:${STRING_LITERAL}|${NUMBER_LITERAL}|true|false|null)`;
const LITERAL_COMPARISON = new RegExp(
	`(?<![\\w$])(${LITERAL})\\s*(==|!=)\\s*(${LITERAL})(?![\\w$])`,
	"g",
);

const UNPARSED_LITERAL = Symbol("unparsed-literal");

function literalValue(raw: string): unknown {
	if (raw.startsWith('"')) {
		try {
			return JSON.parse(raw);
		} catch {
			return UNPARSED_LITERAL;
		}
	}
	if (raw.startsWith("'")) {
		const inner = raw.slice(1, -1);
		// GitHub escapes a single quote by doubling it and has no backslash
		// escape; anything else here is JS-flavoured and is left to
		// `new Function` rather than guessed at.
		if (inner.includes("\\") || inner.includes("'")) {
			return UNPARSED_LITERAL;
		}
		return inner;
	}
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	const value = Number(raw);
	return Number.isNaN(value) ? UNPARSED_LITERAL : value;
}

/**
 * Fold every comparison between two literals to GitHub's own result, before
 * `completedComparisons` rewrites the operators the fold leaves behind. A
 * literal the module cannot parse (a JS-escaped string) is returned untouched,
 * never guessed at. Called before `new Function` sees the expression.
 */
function foldLiteralComparisons(out: string): string {
	return out.replace(
		LITERAL_COMPARISON,
		(whole, leftRaw: string, operator: string, rightRaw: string) => {
			const left = literalValue(leftRaw);
			const right = literalValue(rightRaw);
			if (left === UNPARSED_LITERAL || right === UNPARSED_LITERAL) {
				return whole;
			}
			const equal = githubEquals(left, right);
			return (operator === "==" ? equal : !equal) ? "true" : "false";
		},
	);
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
	return completedComparisons(foldLiteralComparisons(out));
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
 * Read `expr` as one whole `github.event_name == '<literal>'` expression whose
 * atoms are joined by `||`, and return the literals. Returns null -- UNPROVEN
 * -- for every other operator, context path, function, group, or escaped
 * literal.
 *
 * This is a syntactic SHAPE, not an enumeration of event spellings: the atoms
 * are compared through `githubEquals`, so `'PULL_REQUEST'`, `'Pull_Request'`
 * and `'pull_request'` are one atom. The `^…$` anchor is load-bearing: a
 * `github.event_name` inside quoted prose (`'github.event_name' != …`) or
 * beside a second operator (`… && '0' == 0`) is never read as an event-name
 * comparison. A literal may not contain a quote or a backslash, so GitHub's
 * doubled quote and a JS backslash escape stay UNPROVEN rather than guessed.
 */
function eventNameEqualityLiterals(expr: string): string[] | null {
	const body = expressionBody(expr).trim();
	if (body === "") return null;
	const literals: string[] = [];
	for (const atom of body.split("||")) {
		const match = /^\s*github\.event_name\s*==\s*'([^'\\]*)'\s*$/.exec(atom);
		if (match === null) return null;
		literals.push(match[1] as string);
	}
	return literals;
}

/**
 * Does this job-level `if:` PROVE the job never runs on a pull request?
 *
 * A job is excluded only when its `if:` is a whole `github.event_name ==
 * '<literal>'` `||`-expression that is false for EVERY pull-request event
 * name. Everything the shape does not prove -- `!=`, `&&`, grouping, another
 * context path, a status function, a JS-escaped literal, a `github.event_name`
 * inside quoted prose -- returns false, so the job stays pull-request eligible
 * and the #3941 guard keeps covering a real checkout rather than losing it
 * (AGENTS.md shape 48). The trade is deliberate and asymmetric: an unproven
 * condition may keep a genuinely schedule-only job in stage C and ask it to
 * move off the merge ref (over-inclusion), but a real pull-request job is
 * never silently dropped to stage D (the false-exclusion harm this guard
 * exists to prevent).
 */
export function provesNotPullRequestEligible(expr: unknown): boolean {
	if (typeof expr !== "string") return false;
	const literals = eventNameEqualityLiterals(expr);
	if (literals === null) return false;
	return PULL_REQUEST_EVENT_NAMES.every(
		(eventName) =>
			!literals.some((literal) => githubEquals(literal, eventName)),
	);
}
