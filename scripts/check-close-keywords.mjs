import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLOSE_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;
const CLOSE_ISSUE = /\s*:?[ \t]*#(\d+)/y;
const COMMA_ISSUE = /\s*,\s*#(\d+)/y;

export const INVALID_CLOSE_KEYWORD_MESSAGE =
	'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").';

/**
 * Parse same-repository issues named by GitHub close keywords.
 * Cross-repository references (owner/repo#123) intentionally do not match.
 */
export function parseCloseKeywords(body = "") {
	const issues = [];
	const commaLists = [];

	for (const match of body.matchAll(CLOSE_KEYWORD)) {
		const rest = body.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;

		const number = Number(issue[1]);
		if (!issues.includes(number)) issues.push(number);

		COMMA_ISSUE.lastIndex = 0;
		if (COMMA_ISSUE.exec(rest.slice(issue[0].length))) {
			commaLists.push(number);
		}
	}

	return { issues, commaLists };
}

export function lintCloseKeywords(body = "") {
	const parsed = parseCloseKeywords(body);
	return {
		...parsed,
		valid: parsed.commaLists.length === 0,
	};
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

function lintPullRequest() {
	const result = lintCloseKeywords(eventPayload().pull_request?.body ?? "");
	if (!result.valid) {
		console.error(INVALID_CLOSE_KEYWORD_MESSAGE);
		process.exitCode = 1;
		return;
	}
	console.log(`Close-keyword syntax OK (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} referenced).`);
}

function issueState(repository, number) {
	try {
		return execFileSync("gh", ["api", `repos/${repository}/issues/${number}`, "--jq", ".state"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return "not found";
	}
}

function verifyMergedPullRequest() {
	const event = eventPayload();
	const pullRequest = event.pull_request;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!pullRequest || !repository) throw new Error("Pull request event and GITHUB_REPOSITORY are required");

	const { issues } = parseCloseKeywords(pullRequest.body ?? "");
	const unresolved = issues
		.map((number) => ({ number, state: issueState(repository, number) }))
		.filter(({ state }) => state !== "closed");
	if (unresolved.length === 0) {
		console.log(`Post-merge close verification OK (${issues.length} issue${issues.length === 1 ? "" : "s"} closed).`);
		return;
	}

	const details = unresolved.map(({ number, state }) => `#${number} (${state})`).join(", ");
	const message = `Post-merge close verification found issue(s) that were not closed: ${details}. GitHub only applies the first issue in a comma-separated close list; use one close keyword per issue (for example, "Closes #123. Closes #456.").`;
	console.error(message);
	execFileSync("gh", ["pr", "comment", String(pullRequest.number), "--repo", repository, "--body", message], {
		stdio: "inherit",
	});
	process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		if (process.argv[2] === "--lint-pr") lintPullRequest();
		else if (process.argv[2] === "--verify-merged") verifyMergedPullRequest();
		else throw new Error("Usage: node scripts/check-close-keywords.mjs --lint-pr|--verify-merged");
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
