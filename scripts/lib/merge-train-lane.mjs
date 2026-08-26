/**
 * Label-gated merge lane (#2185).
 *
 * The review policy is unchanged and NOT automated here: every PR still gets
 * an adversarial review and a same-reviewer verify before anything merges.
 * Only the maintainer applies `train:approved`, so the label IS the review
 * verdict, and this lane only performs the mechanical last step the
 * orchestrating session used to babysit with a polling loop.
 *
 * What the polling loop kept getting wrong, and what this lane fixes:
 *
 * - A fixed timeout expiring silently read as "still pending", forever.
 * - A starved or absent CI run (#2184) also read as "still pending", forever.
 * - A DIRTY PR silently SKIPS its required checks, so "not failing" is not
 *   "passing" (AGENTS.md shape 11).
 *
 * The gate answers those by requiring positive evidence on the EXACT current
 * head: both required checks present, COMPLETED, and SUCCESS, plus a healthy
 * run classification. Everything else is not-green. That single rule is also
 * what re-gates a fix round: a new head has no concluded checks yet, so the
 * label survives and the merge waits without any stored "approved at SHA"
 * state to drift.
 */

import { fetchOpenPullRequests, REQUIRED_CHECKS } from "./merge-train-warden.mjs";
import { fetchHeadRunHealth, RUN_HEALTH } from "./warden-run-health.mjs";

export const TRAIN_APPROVED_LABEL = "train:approved";
export const TRAIN_SQUASH_LABEL = "train:squash";

// Advisory checks may fail without blocking a merge. The list is explicit and
// the gate is FAIL-CLOSED: anything not named here that fails blocks the
// merge. An allowlist that guessed broadly would be the merge-lane spelling
// of "silencing counted as fixing" (shape 10).
export const ADVISORY_CHECKS = new Set([
	"SonarCloud Code Analysis",
	"CodeQL",
]);

// Only positive evidence of a settled pass. GitHub's CheckRun status is
// QUEUED / IN_PROGRESS / COMPLETED and conclusion is null until COMPLETED
// (probed 2026-08-26 against this repository's own open PRs).
export const CONCLUDED_STATUS = "COMPLETED";
export const PASSING_CONCLUSION = "SUCCESS";

// A non-advisory check in any of these states blocks the merge.
export const BLOCKING_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"STALE",
]);

// CLEAN and BEHIND are the "clean or behind-with-no-conflict" states the
// issue names. UNSTABLE is included because it means only NON-required checks
// are unhappy, and the blocking-conclusion scan above already judges those on
// their own merits. DIRTY, BLOCKED, DRAFT, and UNKNOWN are never merged.
export const MERGEABLE_STATES = new Set(["CLEAN", "BEHIND", "UNSTABLE"]);

export const MERGE_GATE_REASON = {
	NOT_APPROVED: "not-approved",
	CHECKS_UNKNOWN: "checks-unknown",
	REQUIRED_CHECK_ABSENT: "required-check-absent",
	REQUIRED_CHECK_UNCONCLUDED: "required-check-unconcluded",
	REQUIRED_CHECK_NOT_SUCCESS: "required-check-not-success",
	RUN_HEALTH: "run-health",
	FAILING_CHECK: "failing-check",
	MERGE_STATE: "merge-state",
	GREEN: "green",
};

/**
 * Pure gate. `pr` is a normalized warden PR record; `health` is a
 * `classifyHeadRun` result for the same head. Returns the decision plus the
 * reason and a human-readable detail line for the PR comment.
 */
export function evaluateMergeGate(pr, health) {
	// Unlabeled PRs are never touched, and never commented on: the lane must
	// be invisible to every PR the maintainer has not approved.
	if (!pr.labels.has(TRAIN_APPROVED_LABEL)) {
		return {
			merge: false,
			silent: true,
			method: null,
			reason: MERGE_GATE_REASON.NOT_APPROVED,
			detail: `no ${TRAIN_APPROVED_LABEL} label`,
		};
	}

	const method = pr.labels.has(TRAIN_SQUASH_LABEL) ? "squash" : "merge";
	const deny = (reason, detail) => ({
		merge: false,
		silent: false,
		method,
		reason,
		detail,
	});

	// A missing rollup is missing information, not a green head.
	if (pr.checksUnknown)
		return deny(
			MERGE_GATE_REASON.CHECKS_UNKNOWN,
			"GitHub reported no check rollup for the head commit",
		);

	const byName = new Map(pr.checkRuns.map((c) => [c.name, c]));
	for (const name of REQUIRED_CHECKS) {
		const run = byName.get(name);
		// Absent is the DIRTY-skip and dropped-dispatch case. It is the single
		// most important not-green branch in this file.
		if (!run)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
				`\`${name}\` has not reported on \`${pr.headSha}\`; an absent required check is not a passing one`,
			);
		if (run.status !== CONCLUDED_STATUS)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
				`\`${name}\` is ${run.status ?? "unreported"} on \`${pr.headSha}\`, not concluded`,
			);
		if (run.conclusion !== PASSING_CONCLUSION)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_NOT_SUCCESS,
				`\`${name}\` concluded ${run.conclusion ?? "null"} on \`${pr.headSha}\``,
			);
	}

	// Starved and absent runs read as not-green even when a stale check run
	// from an earlier attempt looks settled (#2184).
	if (health.classification !== RUN_HEALTH.NORMAL)
		return deny(
			MERGE_GATE_REASON.RUN_HEALTH,
			`workflow run health is \`${health.classification}\` on \`${pr.headSha}\``,
		);

	const failing = pr.checkRuns.filter(
		(c) =>
			!ADVISORY_CHECKS.has(c.name) &&
			c.conclusion != null &&
			BLOCKING_CONCLUSIONS.has(c.conclusion),
	);
	if (failing.length > 0)
		return deny(
			MERGE_GATE_REASON.FAILING_CHECK,
			`non-advisory checks are failing: ${failing.map((c) => `\`${c.name}\` (${c.conclusion})`).join(", ")}`,
		);

	if (!MERGEABLE_STATES.has(pr.mergeStateStatus))
		return deny(
			MERGE_GATE_REASON.MERGE_STATE,
			`mergeable state is \`${pr.mergeStateStatus}\``,
		);

	return {
		merge: true,
		silent: false,
		method,
		reason: MERGE_GATE_REASON.GREEN,
		detail: `every required check concluded success on \`${pr.headSha}\``,
	};
}

/**
 * Per-head, per-reason dedupe key. The head SHA is in the marker so a fix
 * round gets a fresh wait comment, and the reason is in it so a PR that moves
 * from "waiting for checks" to "checks failed" says so once.
 */
export function laneCommentMarker(headSha, reason) {
	return `<!-- train-lane:${headSha}:${reason} -->`;
}

export function laneCommentBody(pr, gate) {
	const header = gate.merge
		? "**Merge train: merged.**"
		: "**Merge train: holding.**";
	const lines = [header, "", gate.detail, ""];
	if (!gate.merge) {
		lines.push(
			`The \`${TRAIN_APPROVED_LABEL}\` label stays on. This lane re-checks every cycle and merges once the current head's required checks conclude success. Remove the label to abort.`,
			"",
		);
	}
	lines.push(laneCommentMarker(pr.headSha, gate.reason));
	return lines.join("\n");
}

export function mergeFailureCommentBody(pr, gate, status) {
	return [
		"**Merge train: the merge call failed.**",
		"",
		`GitHub refused the \`${gate.method}\` merge of \`${pr.headSha}\` with HTTP ${status}. A 409 means the head moved between the gate read and the merge call, which is the head-change guard working; anything else needs a look.`,
		"",
		laneCommentMarker(pr.headSha, `merge-failed-${status}`),
	].join("\n");
}

async function rest(fetcher, method, url, body) {
	return fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function laneCommentExists(fetcher, owner, repo, pr, reason) {
	const marker = laneCommentMarker(pr.headSha, reason);
	const response = await fetcher(
		`https://api.github.com/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`,
		{ headers: { accept: "application/vnd.github+json" } },
	);
	if (!response.ok) throw new Error(`comments read -> HTTP ${response.status}`);
	const comments = await response.json();
	if (!Array.isArray(comments)) throw new Error("comments read returned no array");
	return comments.some((c) => String(c?.body ?? "").includes(marker));
}

/**
 * The merge call itself. `sha` is the head the gate actually evaluated:
 * GitHub rejects the merge with 409 if the head moved in between, so a fix
 * round pushed mid-cycle cannot be merged on a stale verdict even in the
 * window between this lane's read and its write.
 */
export async function mergePullRequest(fetcher, owner, repo, pr, method) {
	return rest(
		fetcher,
		"PUT",
		`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/merge`,
		{ merge_method: method, sha: pr.headSha },
	);
}

/**
 * Run the lane over every open PR. Returns a per-PR record for the run
 * summary. An unlabeled PR costs zero API calls beyond the shared list read.
 */
export async function runMergeLane({ fetcher, owner, repo, now = Date.now() }) {
	const { prs, errors: listErrors } = await fetchOpenPullRequests(
		fetcher,
		owner,
		repo,
	);
	const results = [];
	if (listErrors.length > 0) {
		results.push({
			number: null,
			reason: "list-error",
			merged: false,
			errors: listErrors.map((message) => ({ message, benign: false })),
		});
	}

	for (const pr of prs) {
		if (!pr.labels.has(TRAIN_APPROVED_LABEL)) continue;
		const errors = [];
		const { health, errors: healthErrors } = await fetchHeadRunHealth(
			fetcher,
			owner,
			repo,
			pr.headSha,
			pr.headCommittedDate,
			now,
		);
		for (const message of healthErrors)
			errors.push({ message: `PR #${pr.number}: ${message}`, benign: true });

		const gate = evaluateMergeGate(pr, health);
		let merged = false;

		if (gate.merge) {
			try {
				const response = await mergePullRequest(
					fetcher,
					owner,
					repo,
					pr,
					gate.method,
				);
				merged = response.ok;
				if (!response.ok) {
					errors.push({
						message: `PR #${pr.number}: merge -> HTTP ${response.status}`,
						benign: response.status === 409,
					});
					await postComment(
						fetcher,
						owner,
						repo,
						pr,
						mergeFailureCommentBody(pr, gate, response.status),
						errors,
					);
				}
			} catch (error) {
				errors.push({
					message: `PR #${pr.number}: merge -> ${error instanceof Error ? error.message : String(error)}`,
					benign: false,
				});
			}
		}

		if (merged || !gate.merge) {
			try {
				// A merge success is commented unconditionally (it happens once, and
				// the PR closes). A hold is commented once per head+reason, so a PR
				// waiting three days does not accrue 432 identical comments.
				const alreadySaid =
					!merged &&
					(await laneCommentExists(fetcher, owner, repo, pr, gate.reason));
				if (!alreadySaid)
					await postComment(
						fetcher,
						owner,
						repo,
						pr,
						laneCommentBody(pr, gate),
						errors,
					);
			} catch (error) {
				errors.push({
					message: `PR #${pr.number}: comment -> ${error instanceof Error ? error.message : String(error)}`,
					benign: true,
				});
			}
		}

		results.push({
			number: pr.number,
			url: pr.url,
			reason: gate.reason,
			detail: gate.detail,
			method: gate.method,
			runHealth: health.classification,
			merged,
			errors,
		});
	}
	return results;
}

async function postComment(fetcher, owner, repo, pr, body, errors) {
	const response = await rest(
		fetcher,
		"POST",
		`https://api.github.com/repos/${owner}/${repo}/issues/${pr.number}/comments`,
		{ body },
	);
	if (!response.ok)
		errors.push({
			message: `PR #${pr.number}: comment -> HTTP ${response.status}`,
			benign: true,
		});
}
