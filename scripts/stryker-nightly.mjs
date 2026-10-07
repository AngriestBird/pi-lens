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
 *     `ok` AND a report that covered the whole window (nothing skipped over
 *     the file cap, sampled or cut by the budget: `incompleteReasons`);
 *     otherwise it keeps BASE, so tomorrow's window covers these files again.
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
 * Why the report did not cover its whole window; empty means it did. The
 * marker advances only for an empty list: a file skipped over the cap, a range
 * sampled away, a budget-ended run, or no report at all must be revisited, and
 * the driver exits 0 for every one of those but the last.
 *
 * @param {unknown} report a parsed reports/mutation/mutation.json, or undefined
 * @returns {string[]}
 */
export function incompleteReasons(report) {
	const meta = report?.piLensMutationDiff;
	if (!meta) return ["no mutation report was produced"];
	const reasons = [];
	const capped = meta.filesSkippedOverCap?.length ?? 0;
	if (capped > 0)
		reasons.push(`${capped} file(s) skipped over the --max-files cap`);
	if (meta.rangesSampled) {
		reasons.push(
			`sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges`,
		);
	}
	if (meta.partial) reasons.push("partial run: the budget ended it");
	const tried = meta.rangesEvaluated;
	const total = meta.rangesTotal;
	if (
		typeof tried === "number" &&
		typeof total === "number" &&
		tried < total &&
		!meta.rangesSampled &&
		!meta.partial
	) {
		reasons.push(`${tried} of ${total} ranges evaluated`);
	}
	// Zero mutants is final when there was nothing to mutate (an early exit
	// carries no range count, or the dry run measured none) or every range was
	// tried; a dry-run failure or a budget below the fixed overhead measured
	// mutants it never ran.
	if (
		meta.zeroMutants &&
		reasons.length === 0 &&
		typeof total === "number" &&
		meta.measuredTotalMutants !== 0 &&
		!(typeof tried === "number" && tried >= total)
	) {
		reasons.push("no mutant was evaluated and the dry run measured some");
	}
	return reasons;
}

// GitHub rejects an issue body over 65536 characters. The survivor table is
// bounded below; this is the hard stop for everything else a report can carry.
const MAX_BODY_CHARS = 60_000;
const MAX_SURVIVORS = 50;

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
	const reasons = status === "ok" ? incompleteReasons(report) : [];
	const failed = status !== "ok";
	const advance = !failed && reasons.length === 0;
	const lines = [
		markerOf(advance ? head : base),
		"Updated nightly by the `Stryker nightly` workflow (#4005). **An exploratory test-adequacy report; it gates nothing.** Survivors on added runtime lines are candidates for a missing test, not defects: read each through a real caller before acting.",
		"",
		`- **Window:** \`${base.slice(0, 12)}..${head.slice(0, 12)}\` (base from: ${source})`,
		`- **Status:** ${failed ? "FAILED -- the driver did not finish; this window is retried tomorrow together with the next one" : "ok"}`,
		`- **Marker:** ${advance ? "advanced to this window's head" : `held at the window's base${failed ? "" : `, because the report did not cover the whole window: ${reasons.join("; ")}. The next night's window starts at the same base and covers these files again`}`}`,
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
			: renderMutationMarkdown(report, { maxSurvivors: MAX_SURVIVORS }),
	);
	const body = `${lines.join("\n")}\n`;
	if (body.length <= MAX_BODY_CHARS) return body;
	return `${body.slice(0, MAX_BODY_CHARS)}\n\n_Report truncated at ${MAX_BODY_CHARS} characters; the full report is in the \`mutation-report\` workflow artifact (kept 90 days)._\n`;
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
