#!/usr/bin/env node
/**
 * Nightly Stryker test-adequacy report: the state and body halves (#4005).
 *
 * `.github/workflows/stryker-nightly.yml` runs `scripts/stryker-diff.mjs` over
 * `<last-report-sha>..HEAD` on master and files ONE rolling tracking issue
 * through `scripts/upsert-tracking-issue.mjs`. This script owns the two steps
 * around the driver:
 *
 *   node scripts/stryker-nightly.mjs base --issues FILE --title TITLE
 *     Prints `base=<sha>` and `source=<issue|fallback-no-issue|fallback-bad-sha>`
 *     (GITHUB_OUTPUT lines). The last-report sha is the marker the previous
 *     report left in the tracking issue's body (`gh issue list --json
 *     title,body` output in FILE); no readable marker, or one that is not an
 *     ancestor of HEAD, falls back to the first commit older than 24 hours.
 *
 *   node scripts/stryker-nightly.mjs body --base SHA --head SHA --source S
 *     --status ok|failed --out FILE [--report JSON] [--run-url URL]
 *     Writes the issue body. The marker is advanced to HEAD only for status
 *     `ok`; a failed run keeps BASE so tomorrow's window covers today's too.
 *
 * Why the issue body and not an artifact or a committed file: it needs no
 * permission beyond the `issues: write` the upsert already holds (an artifact
 * read needs `actions: read`, a committed file needs `contents: write` against
 * a protected master), it is durable (artifacts expire), and a maintainer can
 * reset the window by editing the marker.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { renderMutationMarkdown } from "./lib/mutation-report-render.mjs";

const MARKER_RE = /<!-- stryker-nightly:last-report-sha=([0-9a-f]{40}) -->/;
const FALLBACK_WINDOW = "24 hours ago";

export const SOURCES = Object.freeze([
	"issue",
	"fallback-no-issue",
	"fallback-bad-sha",
]);

export const markerOf = (sha) =>
	`<!-- stryker-nightly:last-report-sha=${sha} -->`;

/**
 * The sha the previous report recorded in the tracking issue's body, or null.
 * `issues` is `gh issue list --json title,body`; the issue is found by exact
 * title, as `upsertTrackingIssue` finds it, so an unrelated issue carrying the
 * label (or a marker pasted in a comment-like body elsewhere) never counts.
 *
 * @param {{title: string, body?: string}[]} issues
 * @param {string} title
 * @returns {string | null}
 */
export function parseLastReportSha(issues, title) {
	const issue = (issues ?? []).find((entry) => entry?.title === title);
	return MARKER_RE.exec(issue?.body ?? "")?.[1] ?? null;
}

/**
 * @param {{issues: {title: string, body?: string}[], title: string, isAncestor: (sha: string) => boolean, fallbackBase: () => string}} options
 * @returns {{base: string, source: "issue" | "fallback-no-issue" | "fallback-bad-sha"}}
 */
export function pickBase({ issues, title, isAncestor, fallbackBase }) {
	const recorded = parseLastReportSha(issues, title);
	if (recorded === null) {
		return { base: fallbackBase(), source: "fallback-no-issue" };
	}
	if (!isAncestor(recorded)) {
		return { base: fallbackBase(), source: "fallback-bad-sha" };
	}
	return { base: recorded, source: "issue" };
}

/**
 * @param {{base: string, head: string, source: string, status: "ok" | "failed", report?: unknown, runUrl?: string}} options
 * @returns {string}
 */
export function buildNightlyBody({
	base,
	head,
	source,
	status,
	report,
	runUrl,
}) {
	const failed = status !== "ok";
	const lines = [
		markerOf(failed ? base : head),
		"Updated nightly by the `Stryker nightly` workflow (#4005). **An exploratory test-adequacy report; it gates nothing.** Survivors on added runtime lines are candidates for a missing test, not defects: read each through a real caller before acting.",
		"",
		`- **Window:** \`${base.slice(0, 12)}..${head.slice(0, 12)}\` (base from: ${source})`,
		`- **Status:** ${failed ? "FAILED -- the driver did not finish; this window is retried tomorrow together with the next one" : "ok"}`,
	];
	if (runUrl) lines.push(`- **Run:** ${runUrl}`);
	lines.push(
		"",
		"Kill criterion (#4005): remove this lane when two consecutive reports record no product defect and the #3982 benchmark does not make it cheap.",
		"",
	);
	lines.push(
		report === undefined
			? "No mutation report was produced for this window."
			: renderMutationMarkdown(report),
	);
	return `${lines.join("\n")}\n`;
}

function valueAfter(argv, flag, fallback) {
	const index = argv.indexOf(flag);
	if (index < 0) {
		if (fallback !== undefined) return fallback;
		throw new Error(`${flag} is required`);
	}
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function runBase(argv, cwd) {
	const git = (args) => gitExecFileSync(args, { cwd, encoding: "utf8" }).trim();
	const issues = JSON.parse(readFileSync(valueAfter(argv, "--issues"), "utf8"));
	const picked = pickBase({
		issues,
		title: valueAfter(argv, "--title"),
		isAncestor: (sha) => {
			try {
				gitExecFileSync(["merge-base", "--is-ancestor", sha, "HEAD"], {
					cwd,
					stdio: "ignore",
				});
				return true;
			} catch {
				return false;
			}
		},
		fallbackBase: () =>
			git([
				"rev-list",
				"--max-count=1",
				`--before=${FALLBACK_WINDOW}`,
				"HEAD",
			]) || git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0],
	});
	if (picked.source !== "issue") {
		console.error(
			`stryker-nightly: no usable last-report sha (${picked.source}); window starts at ${picked.base}`,
		);
	}
	return picked;
}

function runBody(argv) {
	const reportPath = valueAfter(argv, "--report", "");
	const status = valueAfter(argv, "--status");
	if (status !== "ok" && status !== "failed") {
		throw new Error("--status must be ok or failed");
	}
	const body = buildNightlyBody({
		base: valueAfter(argv, "--base"),
		head: valueAfter(argv, "--head"),
		source: valueAfter(argv, "--source"),
		status,
		report:
			reportPath && existsSync(reportPath)
				? JSON.parse(readFileSync(reportPath, "utf8"))
				: undefined,
		runUrl: valueAfter(argv, "--run-url", ""),
	});
	writeFileSync(valueAfter(argv, "--out"), body);
	return body;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
	const [command, ...rest] = argv;
	if (command === "base") return runBase(rest, cwd);
	if (command === "body") return runBody(rest);
	throw new Error("usage: stryker-nightly.mjs base|body ...");
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const result = main();
		// `base` prints GITHUB_OUTPUT lines for the workflow to append.
		if (typeof result === "object") {
			console.log(`base=${result.base}\nsource=${result.source}`);
		}
	} catch (error) {
		console.error(`stryker-nightly: failed: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
