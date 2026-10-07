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
 *     [--pending-out FILE]
 *     Prints GITHUB_OUTPUT lines `base=<sha>`, `source=<issue|fallback-no-issue|
 *     fallback-bad-sha>`, `pending=<count>` and `pending_base=<sha|empty>`. The
 *     last-report sha is the marker the previous report left in the tracking
 *     issue's body (`gh issue list --json title,body` output in FILE); no
 *     readable marker, or one that is not an ancestor of HEAD, falls back to
 *     the first commit older than 24 hours. The carry-over queue (below) is
 *     written to --pending-out, one path per line.
 *
 *   node scripts/stryker-nightly.mjs body --issues FILE --title TITLE
 *     --base SHA --head SHA --source S --status ok|failed --out FILE
 *     [--report JSON] [--run-url URL]
 *     Writes the issue body. After a COMPLETED run (status ok and a report) the
 *     marker advances to HEAD; a FAILED run leaves the marker and the queue as
 *     they were, so tomorrow's window covers it again.
 *
 * Carry-over queue: files a run skipped over the --max-files cap, or took but
 * could not finish (ranges sampled away, a budget-ended run), go on a FIFO
 * queue in the body (`<!-- stryker-nightly:pending=a,b -->`, at most 200; the
 * oldest are dropped and the body says so). The next night mutates the queue
 * first, then the new window by weight, under the same cap, and a queued file
 * that was fully evaluated leaves it. `pending-base` is the base of the oldest
 * night that queued a still-pending file, so its earlier changed lines are in
 * range. The list is validated on read (`isQueueablePath`): an edited issue
 * cannot inject a path outside the runtime tree.
 *
 * Why the issue body and not an artifact or a committed file: it needs no
 * permission beyond the `issues: write` the upsert already holds (an artifact
 * read needs `actions: read`, a committed file needs `contents: write` against
 * a protected master), it is durable (artifacts expire), and a maintainer can
 * reset the window by editing the marker.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { renderMutationMarkdown } from "./lib/mutation-report-render.mjs";
import { isQueueablePath } from "./lib/stryker-diff.mjs";

const MARKER_RE = /<!-- stryker-nightly:last-report-sha=([0-9a-f]{40}) -->/;
const PENDING_RE = /<!-- stryker-nightly:pending=([^\n]*?) -->/;
const PENDING_BASE_RE = /<!-- stryker-nightly:pending-base=([0-9a-f]{40}) -->/;
const FALLBACK_WINDOW = "24 hours ago";
export const MAX_PENDING = 200;

export const SOURCES = Object.freeze([
	"issue",
	"fallback-no-issue",
	"fallback-bad-sha",
]);

export const markerOf = (sha) =>
	`<!-- stryker-nightly:last-report-sha=${sha} -->`;

// The pending marker is always written, empty when the queue is: a spoofed
// marker later in the body (a survivor's source text) is never the first match.
const pendingMarkers = (pending, pendingBase) =>
	[
		`<!-- stryker-nightly:pending=${pending.join(",")} -->`,
		...(pending.length > 0 && pendingBase
			? [`<!-- stryker-nightly:pending-base=${pendingBase} -->`]
			: []),
	].join("\n");

/**
 * The carry-over queue the previous report left in the tracking issue's body.
 * Every entry is validated (`isQueueablePath`) and the list is deduped and
 * bounded; anything else is ignored.
 *
 * @param {{title: string, body?: string}[]} issues
 * @param {string} title
 * @returns {{pending: string[], pendingBase: string | null}}
 */
export function parsePending(issues, title) {
	const body =
		(issues ?? []).find((entry) => entry?.title === title)?.body ?? "";
	const raw = PENDING_RE.exec(body)?.[1] ?? "";
	const pending = [...new Set(raw.split(",").map((entry) => entry.trim()))]
		.filter(isQueueablePath)
		.slice(-MAX_PENDING);
	return {
		pending,
		pendingBase:
			pending.length > 0 ? (PENDING_BASE_RE.exec(body)?.[1] ?? null) : null,
	};
}

/**
 * What a COMPLETED report left undone. `capped` files were never taken;
 * `unfinished` says the files it did take were not fully evaluated (ranges
 * sampled away, a budget-ended run, ranges not all tried, or a zero-mutant run
 * cut short). Both go on the queue; neither holds the marker.
 *
 * @param {unknown} report
 * @returns {{capped: string[], unfinished: string[]}}
 */
export function coverageGaps(report) {
	const meta = report?.piLensMutationDiff ?? {};
	const capped = (meta.filesSkippedOverCap ?? []).filter(isQueueablePath);
	const unfinished = [];
	if (meta.rangesSampled) {
		unfinished.push(
			`sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges`,
		);
	}
	if (meta.partial) unfinished.push("partial run: the budget ended it");
	const tried = meta.rangesEvaluated;
	const total = meta.rangesTotal;
	if (
		typeof tried === "number" &&
		typeof total === "number" &&
		tried < total &&
		!meta.rangesSampled &&
		!meta.partial
	) {
		unfinished.push(`${tried} of ${total} ranges evaluated`);
	}
	// Zero mutants is final when there was nothing to mutate (an early exit
	// carries no range count, or the dry run measured none) or every range was
	// tried; a budget below the fixed overhead measured mutants it never ran.
	if (
		meta.zeroMutants &&
		unfinished.length === 0 &&
		typeof total === "number" &&
		meta.measuredTotalMutants !== 0 &&
		!(typeof tried === "number" && tried >= total)
	) {
		unfinished.push("no mutant was evaluated and the dry run measured some");
	}
	return { capped, unfinished };
}

/**
 * The queue after a night. A FAILED run (anything but status ok with a report)
 * changes nothing. A completed run drops the queued files it took, queues the
 * files it skipped over the cap, and re-queues at the back the files it took
 * but could not finish. Entries that no longer exist or are no longer
 * runtime-scoped drop silently; beyond MAX_PENDING the oldest drop and are
 * counted.
 *
 * @param {{oldPending: string[], oldPendingBase: string | null, base: string, status: string, report?: unknown, exists: (file: string) => boolean}} options
 * @returns {{pending: string[], pendingBase: string | null, dropped: number, completed: boolean}}
 */
export function nextQueue({
	oldPending,
	oldPendingBase,
	base,
	status,
	report,
	exists,
}) {
	const meta = report?.piLensMutationDiff;
	if (status !== "ok" || !meta) {
		return {
			pending: oldPending,
			pendingBase: oldPendingBase,
			dropped: 0,
			completed: false,
		};
	}
	const { capped, unfinished } = coverageGaps(report);
	const selected = (meta.filesSelected ?? []).filter(isQueueablePath);
	const taken = new Set(selected);
	const notEvaluable = new Set([
		...(meta.filesUncovered ?? []),
		...(meta.filesNoSourceMap ?? []),
		...(meta.filesNoMutableLines ?? []),
	]);
	const retry =
		unfinished.length > 0
			? selected.filter((file) => !notEvaluable.has(file))
			: [];
	const kept = oldPending.filter((file) => !taken.has(file));
	const all = [...new Set([...kept, ...capped, ...retry])].filter(
		(file) => isQueueablePath(file) && exists(file),
	);
	const dropped = Math.max(0, all.length - MAX_PENDING);
	const pending = all.slice(dropped);
	const carriesOld =
		kept.some((file) => pending.includes(file)) ||
		retry.some((file) => oldPending.includes(file) && pending.includes(file));
	return {
		pending,
		pendingBase:
			pending.length === 0
				? null
				: carriesOld
					? (oldPendingBase ?? base)
					: base,
		dropped,
		completed: true,
	};
}

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

// GitHub rejects an issue body over 65536 characters. The survivor table is
// bounded below; this is the hard stop for everything else a report can carry.
const MAX_BODY_CHARS = 60_000;
const MAX_SURVIVORS = 50;

/**
 * @param {{base: string, head: string, source: string, status: "ok" | "failed", report?: unknown, runUrl?: string, oldPending?: string[], oldPendingBase?: string | null, exists?: (file: string) => boolean}} options
 * @returns {string}
 */
export function buildNightlyBody({
	base,
	head,
	source,
	status,
	report,
	runUrl,
	oldPending = [],
	oldPendingBase = null,
	exists = () => true,
}) {
	const queue = nextQueue({
		oldPending,
		oldPendingBase,
		base,
		status,
		report,
		exists,
	});
	const gaps = queue.completed ? coverageGaps(report) : null;
	const notes = gaps
		? [
				...(gaps.capped.length > 0
					? [`${gaps.capped.length} file(s) skipped over the --max-files cap`]
					: []),
				...gaps.unfinished,
			]
		: [];
	const lines = [
		markerOf(queue.completed ? head : base),
		pendingMarkers(queue.pending, queue.pendingBase),
		"Updated nightly by the `Stryker nightly` workflow (#4005). **An exploratory test-adequacy report; it gates nothing.** Survivors on added runtime lines are candidates for a missing test, not defects: read each through a real caller before acting.",
		"",
		`- **Window:** \`${base.slice(0, 12)}..${head.slice(0, 12)}\` (base from: ${source})`,
		queue.completed
			? "- **Status:** ok"
			: "- **Status:** FAILED -- the driver did not finish; the marker and the carry-over queue are unchanged, so the next night's window covers this one again",
		`- **Coverage:** ${queue.completed ? (notes.length === 0 ? "the whole window was evaluated" : `not complete: ${notes.join("; ")}`) : "n/a"}`,
		`- **Carry-over queue:** ${queue.pending.length} file(s) (FIFO, at most ${MAX_PENDING}; the next night mutates these first, under the same cap)${queue.dropped > 0 ? `; ${queue.dropped} oldest file(s) were dropped because the queue overflowed` : ""}`,
	];
	if (runUrl) lines.push(`- **Run:** ${runUrl}`);
	if (queue.pending.length > 0) {
		lines.push(
			"",
			`<details><summary>Queued files (${queue.pending.length})</summary>\n\n${queue.pending.map((file) => `- \`${file}\``).join("\n")}\n\n</details>`,
		);
	}
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
	const title = valueAfter(argv, "--title");
	const picked = pickBase({
		issues,
		title,
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
	const { pending, pendingBase } = parsePending(issues, title);
	// The queued files' earlier changes are read against pendingBase; a base git
	// does not know (rewritten history, a hand edit) falls back to the window's.
	const baseOk =
		pendingBase !== null &&
		(() => {
			try {
				gitExecFileSync(["merge-base", "--is-ancestor", pendingBase, "HEAD"], {
					cwd,
					stdio: "ignore",
				});
				return true;
			} catch {
				return false;
			}
		})();
	const pendingOut = valueAfter(argv, "--pending-out", "");
	if (pendingOut) {
		writeFileSync(
			pendingOut,
			pending.length > 0 ? `${pending.join("\n")}\n` : "",
		);
	}
	return { ...picked, pending, pendingBase: baseOk ? pendingBase : null };
}

function runBody(argv, cwd) {
	const reportPath = valueAfter(argv, "--report", "");
	const status = valueAfter(argv, "--status");
	if (status !== "ok" && status !== "failed") {
		throw new Error("--status must be ok or failed");
	}
	const { pending, pendingBase } = parsePending(
		JSON.parse(readFileSync(valueAfter(argv, "--issues"), "utf8")),
		valueAfter(argv, "--title"),
	);
	const body = buildNightlyBody({
		oldPending: pending,
		oldPendingBase: pendingBase,
		exists: (file) => existsSync(join(cwd, file)),
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
	if (command === "body") return runBody(rest, cwd);
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
			console.log(
				`base=${result.base}\nsource=${result.source}\npending=${result.pending.length}\npending_base=${result.pendingBase ?? ""}`,
			);
		}
	} catch (error) {
		console.error(`stryker-nightly: failed: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
