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

// #2096 shape (review round 1, F5): bound the read BEFORE interpretation. A
// classifier that scans an unbounded log is itself a resource-exhaustion
// risk, and the signal this classifier looks for -- a FAIL block, a
// mem-watch verdict, an OOM kill line -- is always near the END of a vitest
// run's stdout, so keeping the tail is the same trade capture-runner-output
// fixtures make. This is a lossy read by design: content dropped by the cap
// is invisible to every pattern below, matching how a human skimming "the
// end of the log" would triage it too.
const MAX_LOG_BYTES = 2 * 1024 * 1024;

// vitest's summary block for a failing test: (real log, run 32913518938,
// job 98012237782) " FAIL  default tests/clients/word-index-lifecycle.test.ts
// > word-index lifecycle — full mode (#348) > reuses a fresh persisted
// snapshot without rebuilding". The project label ("default") sits between
// FAIL and the file path.
const FAIL_LINE = /FAIL\s+\S+\s+(\S+\.test\.tsx?)\s*>\s*(.+)/;
// A file-level FAIL with no "> testname" -- a collection/import error never
// reaches a single test, so vitest has no test name to print (review round
// 1, F2/P2). Deliberately looser than FAIL_LINE: only used when FAIL_LINE
// itself doesn't match.
const BARE_FAIL_LINE = /FAIL\b.*?(\S+\.test\.tsx?)(?=\s|$)/m;
// (real log, same run) "AssertionError: expected false to be true //
// Object.is equality"
const ASSERTION_LINE = /AssertionError:\s*(.+)/;
// vitest prints this inline, AS EACH FILE FINISHES, before the end-of-run
// "Failed Tests" summary block ever gets a chance to print (real log, run
// 32913518938, job 98012237782, line 536): " ❯  default
// tests/clients/word-index-lifecycle.test.ts (5 tests | 1 failed) 460ms".
// This is the review's F2/P1 fix: an OOM kill immediately AFTER this line
// prints, but before the summary block, must still classify real -- the
// summary block is not the only place a failure is visible.
const INLINE_SUITE_FAIL =
	/❯\s+\S+\s+(\S+\.test\.tsx?)\s*\(\d+\s*tests?\s*\|\s*(\d+)\s*failed\)/;
// The per-test inline marker inside that same block (real log, same run,
// line 539): "     × reuses a fresh persisted snapshot without rebuilding
// 127ms" -- a fallback when the suite-level line above got lost to log
// truncation but an individual test's "×" line survived.
const INLINE_TEST_FAIL_MARKER = /^\s*×\s+(.+?)\s*\d*m?s?\s*$/m;
// The run's own final tally line (real log, same run): " Tests  1 failed |
// 9837 passed | 48 skipped (9886)". No file/test detail, but a nonzero
// failed count here is unambiguous.
const OVERALL_TESTS_FAILED = /\bTests\s+(\d+)\s+failed\b/;

// The wrapper's own verdict when it survives long enough to observe the
// kill (clients/scripts/lib/memory-watch.mjs:formatVerdict, quoted
// verbatim -- this is the literal string the shipped code emits, not a
// guess at one).
const MEM_WATCH_KILLED = /\[mem-watch\] KILLED[^\r\n]*/;
const MEM_WATCH_SAMPLE = /\[mem-watch\][^\r\n]*availableMb=\d+ of \d+/g;
const EXIT_137_SHAPED = /exit code 137|exitCode=137|signal=SIGKILL/;
// (real log, run 32908647308, job 97998085238) the OOM killer took the
// wrapper process itself, mid test run, before it could print any verdict:
// "<runner tmp>/....sh: line 1:  2464 Killed
// node scripts/with-memory-watch.mjs -- npm test". A bare "Killed" with no
// [mem-watch] line anywhere in the log is the pre-#2042 shape (run
// 32888174877, PR #2058): the wrapper didn't exist yet, so a plain "Killed"
// mid npm-test output is the only signal.
//
// Review round 1, F1: this pattern alone is NOT sufficient -- "Killed" can
// appear in unrelated output (a message from a spawned tool, a test
// description). It is only evaluated ALONGSIDE EXIT_137_SHAPED below;
// deleting that conjunct is the exact vacuous-guard shape the review
// caught (no fixture exercised a bare "Killed" without 137/SIGKILL
// evidence -- see the "bare Killed, no exit evidence" test).
const KILLED_LINE = /(?:^|[\s:])Killed(?:\s|$)/m;

// UNVERIFIED (AGENTS.md shape 16): no real captured pi-lens Unit-tests log
// with a DNS/network failure was found in the accessible run history for
// this issue (the "CodeQL tarball DNS error" #2103 cites ran in a different
// job). This pattern is the documented Node.js/npm error text for a failed
// DNS resolution or registry fetch, not a fixture pulled from a real run --
// flagged here and in the test file so a real occurrence can replace it.
//
// Review round 1, F2/P3: matching this ANYWHERE in the log is unsafe. The
// repo's OWN test corpus ships the literal string
// `{"outcome":"emit_failed","error":"ECONNRESET"}` (tests/clients/
// smells-rollup.test.ts:124), so a recovered warning or a test's own
// console output can contain "ECONNRESET" with no network failure involved.
// Scoped to lines that also carry an explicit error-shaped prefix (npm's
// own "npm error" convention, or the runner's own "##[error]" annotation) --
// a "npm warn" line or arbitrary test output text no longer qualifies.
const NET_PATTERN =
	/getaddrinfo\s+\w+\s+\S+|\bENOTFOUND\b|\bECONNRESET\b|tarball.{0,40}(?:download|fetch).{0,20}fail|net::ERR_NAME_NOT_RESOLVED/i;
const ERROR_PREFIXED_LINE = /^(?:.*\bnpm error\b.*|##\[error\].*)$/im;

/**
 * @typedef {{ kind: "real" | "infra-oom" | "infra-net", detail: string }} Classification
 */

/**
 * Find the strongest "this is a real failure" signal in the (already
 * ANSI-stripped) log, trying the most specific/informative pattern first.
 * Returns null when none of the real-failure shapes are present.
 *
 * @param {string} log
 * @returns {{ detail: string } | null}
 */
function findRealFailureSignal(log) {
	const failMatch = FAIL_LINE.exec(log);
	if (failMatch) {
		return { detail: `${failMatch[1]} > ${failMatch[2].trim()}` };
	}
	const assertionMatch = ASSERTION_LINE.exec(log);
	if (assertionMatch) {
		return { detail: `unknown file > ${assertionMatch[1].trim()}` };
	}
	const inlineSuite = INLINE_SUITE_FAIL.exec(log);
	if (inlineSuite) {
		return {
			detail: `${inlineSuite[1]} (${inlineSuite[2]} failed, inline marker -- no end-of-run summary printed)`,
		};
	}
	const bareFail = BARE_FAIL_LINE.exec(log);
	if (bareFail) {
		return {
			detail: `${bareFail[1]} (file-level failure -- no ">"-separated test name, e.g. an import/collection error)`,
		};
	}
	const overallFailed = OVERALL_TESTS_FAILED.exec(log);
	if (overallFailed && Number(overallFailed[1]) > 0) {
		return {
			detail: `${overallFailed[1]} test(s) failed (overall tally line; no per-file detail found)`,
		};
	}
	const inlineTest = INLINE_TEST_FAIL_MARKER.exec(log);
	if (inlineTest) {
		return {
			detail: `unknown file > ${inlineTest[1].trim()} (inline "×" marker -- no end-of-run summary printed)`,
		};
	}
	return null;
}

/**
 * Classify one failed job's log. A real failure -- ANY of the shapes
 * findRealFailureSignal recognizes -- always wins over infra-shaped noise
 * elsewhere in the same log (acceptance criterion: "real failures are never
 * labeled infra"), so that check runs FIRST, unconditionally, before any
 * OOM/network pattern is even considered.
 *
 * @param {string} rawLog
 * @returns {Classification}
 */
export function classifyFailureLog(rawLog) {
	const original = rawLog ?? "";
	if (original.trim().length === 0) {
		// Review round 1, F5: distinguish "we read nothing" from "we read
		// something and didn't recognize it" -- an empty log usually means the
		// fetch itself failed or raced the job's log upload, which is a
		// different failure mode than a genuinely unrecognized failure shape.
		return {
			kind: "real",
			detail:
				"empty log (0 bytes read) -- nothing to classify, treated as real out of caution",
		};
	}
	// F5: cap BEFORE any interpretation, not after -- a pattern that happened
	// to match in the discarded head of the log must have no effect on the
	// result (see the truncation test).
	const bounded =
		original.length > MAX_LOG_BYTES ? original.slice(-MAX_LOG_BYTES) : original;
	const log = stripAnsi(bounded);

	const realSignal = findRealFailureSignal(log);
	if (realSignal) {
		return { kind: "real", detail: realSignal.detail };
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

	const errorLine = ERROR_PREFIXED_LINE.exec(log);
	const netMatch = errorLine ? NET_PATTERN.exec(errorLine[0]) : null;
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

// rerun marker state: "true" once the rerun POST actually succeeded,
// "false" when no rerun was attempted (a real classification, or a not-yet
// -eligible infra one), or "failed:<http-status>" when an attempt was made
// but the API call itself failed (review round 1, F4) -- see
// shouldTriggerRerun for why only "true" blocks a future retry.
const MARKER_PATTERN =
	/<!--\s*ci-classifier:sha=([0-9a-fA-F]{7,40})\s+rerun=(true|false|failed:\d+)\s*-->/;

/**
 * @param {string} sha
 * @param {string} rerunState "true" | "false" | `failed:${number}`
 */
export function buildMarker(sha, rerunState) {
	return `<!-- ci-classifier:sha=${sha} rerun=${rerunState} -->`;
}

/**
 * @param {string | null | undefined} commentBody
 * @returns {{ sha: string, rerunState: string, rerunTriggered: boolean } | null}
 */
export function parseClassifierMarker(commentBody) {
	if (!commentBody) return null;
	const match = MARKER_PATTERN.exec(commentBody);
	if (!match) return null;
	return {
		sha: match[1],
		rerunState: match[2],
		rerunTriggered: match[2] === "true",
	};
}

/**
 * The once-per-SHA rerun guard. A real failure is never rerun, full stop.
 * An infra classification is rerun-eligible UNLESS the PR's current
 * classifier comment already carries a `rerun=true` marker for this EXACT
 * SHA -- a different SHA (a new push) always gets to try again, because the
 * guard's job is "don't loop on the same commit", not "never rerun this PR
 * again". Review round 1, F4: a marker of "failed:<status>" (the rerun API
 * call itself failed) is NOT "already triggered" -- it must remain eligible
 * so the next invocation can retry.
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
 * @param {{ classification: Classification, sha: string, rerunState: string }} args
 */
export function buildCommentBody({ classification, sha, rerunState }) {
	const suffix = rerunState.startsWith("failed:")
		? `; rerun attempt failed (HTTP ${rerunState.slice("failed:".length)}, will retry next check)`
		: rerunState === "true"
			? "; auto-rerun triggered"
			: "";
	const line =
		classification.kind === "real"
			? `ci-classifier: real — first failure: ${classification.detail}`
			: `ci-classifier: ${classification.kind} (${classification.detail}${suffix})`;
	return `${line} ${buildMarker(sha, rerunState)}`;
}

/**
 * Decide a classification and the comment body ASSUMING any eligible rerun
 * would succeed. Pure -- no I/O -- used for testing the classification and
 * guard logic in isolation. The real orchestration (runClassifier) does NOT
 * use this to decide the final marker state: it attempts the rerun FIRST
 * and only then knows whether "true" or "failed:<status>" is honest (review
 * round 1, F4) -- see runClassifier.
 *
 * @param {{ rawLog: string, sha: string, existingCommentBody: string | null | undefined }} args
 */
export function decideClassifierAction({ rawLog, sha, existingCommentBody }) {
	const classification = classifyFailureLog(rawLog);
	const existingMarker = parseClassifierMarker(existingCommentBody);
	const eligibleForRerun = shouldTriggerRerun({
		classification,
		sha,
		existingMarker,
	});
	const rerunState = eligibleForRerun
		? "true"
		: existingMarker &&
			  existingMarker.sha === sha &&
			  existingMarker.rerunTriggered
			? "true"
			: "false";
	const commentBody = buildCommentBody({ classification, sha, rerunState });
	// `rerunTriggered` means "did THIS pass trigger a rerun", not "does the
	// marker's cumulative state say true" -- eligibleForRerun already IS
	// that this-pass answer (this pure function assumes an eligible attempt
	// always succeeds; see runClassifier for the real, attempt-then-record
	// version).
	return { classification, rerunTriggered: eligibleForRerun, commentBody };
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
	// A DELETE (comment cleanup, review round 1 F3) returns 204 with no body --
	// response.json() would throw parsing empty text, and no caller needs the
	// return value for that verb.
	try {
		return await response.json();
	} catch {
		return null;
	}
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

/**
 * Review round 1, F3: two concurrent invocations for the same SHA can both
 * read "no existing comment" before either writes, each posting its own
 * comment. Called only after THIS call posted a brand-new comment (a PATCH
 * to an already-existing single comment can't itself create a duplicate).
 * Re-reads the comment list; if more than one classifier comment now claims
 * this SHA, the earliest (lowest id) wins and every later duplicate is
 * deleted -- including this call's own comment, if it lost the race.
 *
 * @returns {Promise<{ isWinner: boolean, winningCommentId: number | undefined }>}
 */
export async function reconcileDuplicateClassifierComments({
	fetcher,
	owner,
	repo,
	prNumber,
	sha,
	postedCommentId,
}) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const comments = await restJson(
		fetcher,
		"GET",
		`${base}/issues/${prNumber}/comments?per_page=100`,
	);
	const forSha = comments
		.filter((comment) => {
			const marker = parseClassifierMarker(comment.body);
			return marker && marker.sha === sha;
		})
		.sort((a, b) => a.id - b.id);
	if (forSha.length <= 1) {
		return { isWinner: true, winningCommentId: postedCommentId };
	}
	const winner = forSha[0];
	for (const duplicate of forSha.slice(1)) {
		await restJson(
			fetcher,
			"DELETE",
			`${base}/issues/comments/${duplicate.id}`,
		);
	}
	return {
		isWinner: winner.id === postedCommentId,
		winningCommentId: winner.id,
	};
}

/**
 * Attempt the rerun. Returns a result instead of throwing on an HTTP
 * failure (review round 1, F4) so the caller can record an honest
 * "failed:<status>" marker rather than either lying (marking rerun=true
 * before knowing the call succeeded) or crashing the whole classification.
 *
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function attemptRerun({ fetcher, owner, repo, runId }) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	try {
		const response = await fetcher(
			`${base}/actions/runs/${runId}/rerun-failed-jobs`,
			{
				method: "POST",
				headers: { accept: "application/vnd.github+json" },
			},
		);
		if (response.ok || response.status === 201)
			return { ok: true, status: response.status };
		return { ok: false, status: response.status };
	} catch {
		// A thrown network error carries no HTTP status -- 0 is not a real
		// status code, so it can never collide with a genuine server response
		// and still round-trips through the marker's `failed:<status>` shape.
		return { ok: false, status: 0 };
	}
}

/**
 * Orchestrate one run: classify, attempt the rerun (when eligible) BEFORE
 * writing any marker that claims it happened (review round 1, F4), upsert
 * the sticky comment with the ACTUAL outcome, and reconcile a concurrent
 * duplicate comment for the same SHA (review round 1, F3).
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
	const classification = classifyFailureLog(rawLog);
	const existingMarker = parseClassifierMarker(existingComment?.body);
	const eligibleForRerun = shouldTriggerRerun({
		classification,
		sha,
		existingMarker,
	});

	// F4: the rerun attempt happens BEFORE the marker is built, so the
	// comment can only ever claim what actually happened.
	let rerunState = "false";
	// `rerunTriggeredThisPass` answers "did THIS invocation just cause a
	// rerun" (what the CLI's own log line reports) -- distinct from
	// `rerunState`, the CUMULATIVE marker/comment state, which stays "true"
	// on a later re-invocation that finds the rerun already succeeded
	// earlier for this exact SHA (see the `else if` below).
	let rerunTriggeredThisPass = false;
	if (eligibleForRerun) {
		const result = await attemptRerun({ fetcher, owner, repo, runId });
		rerunState = result.ok ? "true" : `failed:${result.status}`;
		rerunTriggeredThisPass = result.ok;
	} else if (
		existingMarker &&
		existingMarker.sha === sha &&
		existingMarker.rerunTriggered
	) {
		// Not eligible BECAUSE a prior invocation already succeeded for this
		// exact SHA -- carry that forward so the comment keeps reflecting it,
		// rather than regressing to "false" and implying nothing ever ran.
		// This pass itself triggered nothing, though (rerunTriggeredThisPass
		// stays false).
		rerunState = "true";
	}

	const commentBody = buildCommentBody({ classification, sha, rerunState });
	const postedComment = await upsertComment({
		fetcher,
		owner,
		repo,
		prNumber,
		existingComment,
		body: commentBody,
	});

	let result = {
		classification,
		rerunTriggered: rerunTriggeredThisPass,
		commentBody,
		sha,
		prNumber,
		jobId,
		jobName: resolvedJobName,
	};

	// F3: only a brand-new comment can race a concurrent invocation's brand
	// -new comment into a duplicate -- a PATCH to an existing single comment
	// cannot itself create one.
	if (!existingComment) {
		const reconciled = await reconcileDuplicateClassifierComments({
			fetcher,
			owner,
			repo,
			prNumber,
			sha,
			postedCommentId: postedComment?.id,
		});
		if (!reconciled.isWinner) {
			// A concurrent invocation's earlier comment owns this SHA now; this
			// call's own rerun attempt (if any) already fired and can't be
			// undone -- GitHub's own rerun-failed-jobs idempotency (rerunning an
			// already-queued/in-progress run is a no-op) covers that overlap.
			result = {
				...result,
				rerunTriggered: false,
				supersededByCommentId: reconciled.winningCommentId,
			};
		}
	}

	return result;
}
