// Pure classification logic for `scripts/classify-ci-failure.mjs` (#2103).
//
// Kept separate from the CLI so the log-reading heuristics and the
// once-per-SHA rerun guard are unit-testable without a GitHub event or a
// network call (the check-pr-title.mjs / merge-train-warden.mjs pattern).
//
// The problem this solves is not the OOM itself, it is the JUDGMENT cost: the
// 2026-08-25/26 merge train paid a manual log read and a judged rerun for
// every exit-137 kill, even though most of them carry zero failing
// assertions and are indistinguishable infrastructure noise (#2042). This
// module turns "read the log, decide" into a function a human or an
// orchestrator can call on a run id.

/** Strips the ANSI color/cursor codes vitest's reporter and GitHub Actions
 * both wrap every line in. Every pattern below matches against the stripped
 * text -- matching raw escape-coded text is what makes log heuristics
 * brittle across reporter versions. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
export function stripAnsi(text) {
	return text.replace(ANSI_PATTERN, "");
}

// vitest's summary block for a failing test: (real log, run 32913518938,
// job 98012237782) " FAIL  default tests/clients/word-index-lifecycle.test.ts
// > word-index lifecycle — full mode (#348) > reuses a fresh persisted
// snapshot without rebuilding". The project label ("default") sits between
// FAIL and the file path.
const FAIL_LINE = /FAIL\s+\S+\s+(\S+\.test\.tsx?)\s*>\s*(.+)/;
// (real log, same run) "AssertionError: expected false to be true //
// Object.is equality"
const ASSERTION_LINE = /AssertionError:\s*(.+)/;

// The wrapper's own verdict when it survives long enough to observe the
// kill (clients/scripts/lib/memory-watch.mjs:formatVerdict, quoted
// verbatim -- this is the literal string the shipped code emits, not a
// guess at one).
const MEM_WATCH_KILLED = /\[mem-watch\] KILLED[^\r\n]*/;
const MEM_WATCH_SAMPLE = /\[mem-watch\][^\r\n]*availableMb=\d+ of \d+/g;
const EXIT_137_SHAPED = /exit code 137|exitCode=137|signal=SIGKILL/;
// (real log, run 32908647308, job 97998085238) the OOM killer took the
// wrapper process itself, mid test run, before it could print any verdict:
// "/home/runner/work/_temp/....sh: line 1:  2464 Killed
// node scripts/with-memory-watch.mjs -- npm test". A bare "Killed" with no
// [mem-watch] line anywhere in the log is the pre-#2042 shape (run
// 32888174877, PR #2058): the wrapper didn't exist yet, so a plain "Killed"
// mid npm-test output is the only signal.
const KILLED_LINE = /(?:^|[\s:])Killed(?:\s|$)/m;

// UNVERIFIED (AGENTS.md shape 16): no real captured pi-lens Unit-tests log
// with a DNS/network failure was found in the accessible run history for
// this issue (the "CodeQL tarball DNS error" #2103 cites ran in a different
// job). This pattern is the documented Node.js/npm error text for a failed
// DNS resolution or registry fetch, not a fixture pulled from a real run --
// flagged here and in the test file so a real occurrence can replace it.
const NET_PATTERN =
	/getaddrinfo\s+\w+\s+\S+|\bENOTFOUND\b|\bECONNRESET\b|tarball.{0,40}(?:download|fetch).{0,20}fail|net::ERR_NAME_NOT_RESOLVED/i;

/**
 * @typedef {{ kind: "real" | "infra-oom" | "infra-net", detail: string }} Classification
 */

/**
 * Classify one failed job's log. A real failure (a FAIL line or a raw
 * AssertionError) always wins over infra-shaped noise elsewhere in the same
 * log -- acceptance criterion: "real failures are never labeled infra" -- so
 * that check runs FIRST, unconditionally, before any OOM/network pattern is
 * even considered.
 *
 * @param {string} rawLog
 * @returns {Classification}
 */
export function classifyFailureLog(rawLog) {
	const log = stripAnsi(rawLog ?? "");

	const failMatch = FAIL_LINE.exec(log);
	const assertionMatch = ASSERTION_LINE.exec(log);
	if (failMatch || assertionMatch) {
		const file = failMatch?.[1] ?? "unknown file";
		const test =
			failMatch?.[2]?.trim() ?? assertionMatch?.[1]?.trim() ?? "unknown test";
		return { kind: "real", detail: `${file} > ${test}` };
	}

	const killedVerdict = MEM_WATCH_KILLED.exec(log);
	if (killedVerdict) {
		return {
			kind: "infra-oom",
			detail: `no failing assertion; ${killedVerdict[0].trim()}`,
		};
	}

	if (KILLED_LINE.test(log) && EXIT_137_SHAPED.test(log)) {
		const samples = log.match(MEM_WATCH_SAMPLE);
		const lastSample = samples?.[samples.length - 1]?.trim();
		const detail = lastSample
			? `no failing assertion; last sample before the kill: ${lastSample}`
			: "no failing assertion; no [mem-watch] verdict line -- the OOM killer took the wrapper itself";
		return { kind: "infra-oom", detail };
	}

	const netMatch = NET_PATTERN.exec(log);
	if (netMatch) {
		return {
			kind: "infra-net",
			detail: `no failing assertion; network error: ${netMatch[0].trim()}`,
		};
	}

	// Spec default (#2103 proposal step 1): "otherwise real". A failing job
	// this classifier doesn't recognize the shape of is never assumed to be
	// infra -- an unrecognized shape must not be eligible for an automatic
	// rerun (see shouldTriggerRerun).
	return {
		kind: "real",
		detail:
			"no FAIL/AssertionError/OOM/network signature recognized in the log",
	};
}

const MARKER_PATTERN =
	/<!--\s*ci-classifier:sha=([0-9a-fA-F]{7,40})\s+rerun=(true|false)\s*-->/;

/**
 * @param {string} sha
 * @param {boolean} rerunTriggered
 */
export function buildMarker(sha, rerunTriggered) {
	return `<!-- ci-classifier:sha=${sha} rerun=${rerunTriggered} -->`;
}

/**
 * @param {string | null | undefined} commentBody
 * @returns {{ sha: string, rerunTriggered: boolean } | null}
 */
export function parseClassifierMarker(commentBody) {
	if (!commentBody) return null;
	const match = MARKER_PATTERN.exec(commentBody);
	if (!match) return null;
	return { sha: match[1], rerunTriggered: match[2] === "true" };
}

/**
 * The once-per-SHA rerun guard. A real failure is never rerun, full stop.
 * An infra classification is rerun-eligible UNLESS the PR's current
 * classifier comment already carries a `rerun=true` marker for this EXACT
 * SHA -- a different SHA (a new push) always gets to try again, because the
 * guard's job is "don't loop on the same commit", not "never rerun this PR
 * again".
 *
 * @param {{ classification: Classification, sha: string, existingMarker: { sha: string, rerunTriggered: boolean } | null }} args
 */
export function shouldTriggerRerun({ classification, sha, existingMarker }) {
	if (classification.kind === "real") return false;
	if (
		existingMarker &&
		existingMarker.sha === sha &&
		existingMarker.rerunTriggered
	) {
		return false;
	}
	return true;
}

/**
 * Build the one-line sticky comment body (issue #2103's own examples:
 * "ci-classifier: infra-oom (0 assertions; auto-rerun triggered)" /
 * "ci-classifier: real — first failure: <file> > <test>"), with the
 * machine-readable marker appended on the same line so the comment stays
 * one visible line and is still upsertable per SHA.
 *
 * @param {{ classification: Classification, sha: string, rerunTriggered: boolean }} args
 */
export function buildCommentBody({ classification, sha, rerunTriggered }) {
	const line =
		classification.kind === "real"
			? `ci-classifier: real — first failure: ${classification.detail}`
			: `ci-classifier: ${classification.kind} (${classification.detail}${
					rerunTriggered ? "; auto-rerun triggered" : ""
				})`;
	return `${line} ${buildMarker(sha, rerunTriggered)}`;
}

/**
 * Tie the pieces together into one decision, given a log and whatever
 * classifier comment (if any) is already on the PR. Pure -- no I/O -- so the
 * CLI's fetch/post calls stay thin and this decision is fully unit-testable.
 *
 * @param {{ rawLog: string, sha: string, existingCommentBody: string | null | undefined }} args
 */
export function decideClassifierAction({ rawLog, sha, existingCommentBody }) {
	const classification = classifyFailureLog(rawLog);
	const existingMarker = parseClassifierMarker(existingCommentBody);
	const rerunTriggered = shouldTriggerRerun({
		classification,
		sha,
		existingMarker,
	});
	const commentBody = buildCommentBody({ classification, sha, rerunTriggered });
	return { classification, rerunTriggered, commentBody };
}

// ---------------------------------------------------------------------------
// I/O layer. Every function below takes an injected `fetcher` (the
// merge-train-warden.mjs pattern, scripts/lib/merge-train-warden.mjs:138) so
// the orchestration in runClassifier is testable against a mocked GitHub API
// with no network call and no gh CLI dependency.
// ---------------------------------------------------------------------------

async function restJson(fetcher, method, url, body) {
	const response = await fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`${method} ${url} -> HTTP ${response.status} ${text}`.trim(),
		);
	}
	return response.json();
}

/** Job logs are served as plain text (via a redirect the injected fetcher
 * must follow), not JSON -- kept separate from restJson for that reason. */
async function fetchText(fetcher, url) {
	const response = await fetcher(url, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) {
		throw new Error(`GET ${url} -> HTTP ${response.status}`);
	}
	return response.text();
}

/**
 * Resolve a run's head SHA, its associated PR number (when GitHub reports
 * one -- same-repo pushes and PRs both do; a fork PR or a bare workflow_run
 * event may not, so callers can pass an explicit PR number instead), and the
 * id of the job to classify.
 *
 * @param {{ fetcher: typeof fetch, owner: string, repo: string, runId: number | string, jobName?: string }} args
 */
export async function fetchRunAndFailedJob({
	fetcher,
	owner,
	repo,
	runId,
	jobName,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const run = await restJson(fetcher, "GET", `${base}/actions/runs/${runId}`);
	const jobsResponse = await restJson(
		fetcher,
		"GET",
		`${base}/actions/runs/${runId}/jobs`,
	);
	const jobs = jobsResponse.jobs ?? [];
	const failedJob =
		jobs.find(
			(job) =>
				job.conclusion === "failure" && (!jobName || job.name === jobName),
		) ?? jobs.find((job) => job.conclusion === "failure");
	if (!failedJob) {
		throw new Error(
			`run ${runId} has no failed job${jobName ? ` named "${jobName}"` : ""}`,
		);
	}
	const prNumber = run.pull_requests?.[0]?.number ?? null;
	return {
		sha: run.head_sha,
		prNumber,
		jobId: failedJob.id,
		jobName: failedJob.name,
	};
}

export async function fetchJobLog({ fetcher, owner, repo, jobId }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	return fetchText(fetcher, `${base}/actions/jobs/${jobId}/logs`);
}

/**
 * Find this PR's existing classifier comment, if any -- there is at most one
 * at a time (upsert, never append), so the first match wins.
 */
export async function findExistingClassifierComment({
	fetcher,
	owner,
	repo,
	prNumber,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const comments = await restJson(
		fetcher,
		"GET",
		`${base}/issues/${prNumber}/comments?per_page=100`,
	);
	return (
		comments.find((comment) => parseClassifierMarker(comment.body) !== null) ??
		null
	);
}

export async function upsertComment({
	fetcher,
	owner,
	repo,
	prNumber,
	existingComment,
	body,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	if (existingComment) {
		return restJson(
			fetcher,
			"PATCH",
			`${base}/issues/comments/${existingComment.id}`,
			{ body },
		);
	}
	return restJson(fetcher, "POST", `${base}/issues/${prNumber}/comments`, {
		body,
	});
}

export async function triggerRerunFailedJobs({ fetcher, owner, repo, runId }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const response = await fetcher(
		`${base}/actions/runs/${runId}/rerun-failed-jobs`,
		{
			method: "POST",
			headers: { accept: "application/vnd.github+json" },
		},
	);
	if (!response.ok && response.status !== 201) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`rerun-failed-jobs -> HTTP ${response.status} ${text}`.trim(),
		);
	}
}

/**
 * Orchestrate one run: classify, upsert the sticky comment, and rerun the
 * failed jobs once per SHA when the classification says infra. Every I/O
 * call is delegated to the functions above so this stays a thin sequence --
 * the actual decision (what to say, whether to rerun) is decideClassifierAction,
 * already covered without any of this I/O.
 *
 * @param {{ fetcher: typeof fetch, owner: string, repo: string, runId: number | string, jobName?: string, prNumber?: number }} args
 */
export async function runClassifier({
	fetcher,
	owner,
	repo,
	runId,
	jobName,
	prNumber: prNumberOverride,
}) {
	const {
		sha,
		prNumber: resolvedPrNumber,
		jobId,
		jobName: resolvedJobName,
	} = await fetchRunAndFailedJob({ fetcher, owner, repo, runId, jobName });
	const prNumber = prNumberOverride ?? resolvedPrNumber;
	if (!prNumber) {
		throw new Error(
			`run ${runId} has no associated pull request; pass an explicit PR number`,
		);
	}

	const rawLog = await fetchJobLog({ fetcher, owner, repo, jobId });
	const existingComment = await findExistingClassifierComment({
		fetcher,
		owner,
		repo,
		prNumber,
	});
	const decision = decideClassifierAction({
		rawLog,
		sha,
		existingCommentBody: existingComment?.body,
	});

	await upsertComment({
		fetcher,
		owner,
		repo,
		prNumber,
		existingComment,
		body: decision.commentBody,
	});

	if (decision.rerunTriggered) {
		await triggerRerunFailedJobs({ fetcher, owner, repo, runId });
	}

	return { ...decision, sha, prNumber, jobId, jobName: resolvedJobName };
}
