import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Repo convention: conventional-commit-style prefix, then an issue reference
// somewhere in the title or body. Merges are merge commits from the PR
// title (see AGENTS.md), so a malformed title becomes the permanent commit
// subject -- catch it before merge, not after.
const CONVENTIONAL_PREFIX =
	/^(feat|fix|chore|docs|refactor|test|ci|perf)(\([^)]+\))?: .+/;
const ISSUE_REF = /#\d+/;

export const MISSING_PREFIX_MESSAGE =
	'PR title must start with a conventional prefix and a colon, for example "fix: repair the widget cache (refs #123)". ' +
	"Allowed prefixes: feat, fix, chore, docs, refactor, test, ci, perf.";

export const MISSING_ISSUE_REF_MESSAGE =
	'PR title or body must reference an issue (e.g. "#123"). Use "Closes #123" when the PR fully resolves the issue, or "Refs #123" when work remains.';

/**
 * Lint a PR title/body pair against the repo's conventional-prefix +
 * issue-ref convention. Pure function so it is unit-testable without a
 * GitHub event payload.
 */
export function lintPrTitle(title = "", body = "") {
	const errors = [];
	if (!CONVENTIONAL_PREFIX.test(title.trim())) {
		errors.push(MISSING_PREFIX_MESSAGE);
	}
	if (!ISSUE_REF.test(title) && !ISSUE_REF.test(body)) {
		errors.push(MISSING_ISSUE_REF_MESSAGE);
	}
	return { valid: errors.length === 0, errors };
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

function lintPullRequestEvent() {
	const pullRequest = eventPayload().pull_request;
	if (!pullRequest) throw new Error("Event payload has no pull_request");
	const result = lintPrTitle(pullRequest.title ?? "", pullRequest.body ?? "");
	if (!result.valid) {
		for (const error of result.errors) console.error(error);
		process.exitCode = 1;
		return;
	}
	console.log(`PR title OK: "${pullRequest.title}"`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		lintPullRequestEvent();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
