/**
 * Head run health (#2184): classify what GitHub Actions actually did with a
 * PR's current head commit.
 *
 * The 2026-08-26 Actions degradation stalled the merge train for hours behind
 * two signatures that every existing gate read as "pending forever":
 *
 * - STARVED RUN: the run concludes `failure`/`startup_failure` while no job
 *   ever executed a step. Verified against the real incident run 32986328966
 *   (`.github/workflows/ci.yml`, conclusion `failure`, `run_attempt` 1): six
 *   jobs sat at `status: "queued"` with `steps: []`, and one matrix job read
 *   `status: "completed", conclusion: "skipped"` with `steps: []`. So "every
 *   job is queued" is NOT the signature — a skipped matrix job breaks it. The
 *   discriminating fact is ZERO EXECUTED STEPS across every job of a run that
 *   nonetheless concluded failed. A genuine test failure always has steps.
 *
 * - ABSENT RUN: no run for a tracked workflow exists on the head at all,
 *   minutes after the commit. GitHub dropped the `pull_request` dispatch.
 *
 * Both are shape 11 in AGENTS.md wearing a new coat: an absent or starved
 * required check is not a passing one. The classifier therefore also emits
 * PENDING and UNKNOWN rather than collapsing "nothing yet" and "we could not
 * read it" into a verdict (shape 10: an empty result must distinguish clean
 * from unavailable).
 */

export const TRACKED_WORKFLOW_PATHS = [
	".github/workflows/ci.yml",
	".github/workflows/lint.yml",
];

// A dispatch that has not appeared within this window is dropped, not slow.
// GitHub queues a `pull_request` run within seconds when the webhook lands;
// the warden's own cadence is 10 minutes, so 12 minutes means "at least one
// full warden cycle has already passed with nothing to see".
export const ABSENT_RUN_GRACE_MINUTES = 12;

// Only a run that is BOTH completed and failed can be starved. `cancelled`
// is excluded on purpose: a human cancelling a run also produces zero
// executed steps, and re-running it would fight the person who cancelled it.
export const STARVED_RUN_CONCLUSIONS = new Set(["failure", "startup_failure"]);

export const RUN_HEALTH = {
	NORMAL: "runs-concluded-normally",
	STARVED: "starved-run",
	ABSENT: "absent-run",
	PENDING: "runs-in-progress",
	UNKNOWN: "run-health-unknown",
};

/**
 * Steps GitHub actually executed for a run. A step is executed once it
 * carries a conclusion; a queued job reports `steps: []`, and a job that
 * GitHub created but never started reports steps with a null conclusion.
 */
export function countExecutedSteps(jobs) {
	if (!Array.isArray(jobs)) return 0;
	let executed = 0;
	for (const job of jobs) {
		for (const step of job?.steps ?? []) {
			if (step?.conclusion != null) executed += 1;
		}
	}
	return executed;
}

/**
 * The starved-run predicate. `run.jobs` must be a KNOWN array: a null jobs
 * list means the jobs read failed, and "we could not look" is not evidence
 * of starvation (that path classifies UNKNOWN instead).
 */
export function isStarvedRun(run) {
	if (!run || run.status !== "completed") return false;
	if (!STARVED_RUN_CONCLUSIONS.has(run.conclusion)) return false;
	if (!Array.isArray(run.jobs)) return false;
	return countExecutedSteps(run.jobs) === 0;
}

/**
 * GitHub returns every run for a head, including superseded ones: the
 * incident head 8e32f127 carried two `lint.yml` runs, an earlier success and
 * a later starved failure. Only the newest run per workflow describes the
 * head's current state.
 */
export function latestRunPerWorkflowPath(runs) {
	const latest = new Map();
	for (const run of runs ?? []) {
		if (!run?.path) continue;
		const current = latest.get(run.path);
		if (!current || runIsNewer(run, current)) latest.set(run.path, run);
	}
	return latest;
}

function runIsNewer(candidate, incumbent) {
	const a = Date.parse(candidate.createdAt ?? "");
	const b = Date.parse(incumbent.createdAt ?? "");
	if (Number.isNaN(a) || Number.isNaN(b)) return Number(candidate.id) > Number(incumbent.id);
	if (a !== b) return a > b;
	return Number(candidate.id) > Number(incumbent.id);
}

/**
 * Classify one head. Pure: the caller supplies the runs (each already
 * carrying its jobs, or `jobs: null` when the jobs read failed), the head's
 * commit date, and the clock.
 *
 * Precedence is STARVED > ABSENT > UNKNOWN > PENDING > NORMAL, because it
 * orders by how actionable the finding is: a starved run has a rerun lever,
 * an absent run has a push lever a bot cannot pull, and the rest are waits.
 * The returned record carries EVERY populated bucket, so one head can both
 * rerun a starved `ci.yml` and be told its `lint.yml` never dispatched.
 */
export function classifyHeadRun({
	runs,
	headCommittedDate,
	now,
	graceMinutes = ABSENT_RUN_GRACE_MINUTES,
	trackedPaths = TRACKED_WORKFLOW_PATHS,
}) {
	const latest = latestRunPerWorkflowPath(runs);
	const starvedRuns = [];
	const absentWorkflows = [];
	const unknownWorkflows = [];
	const pendingWorkflows = [];
	const committedMs = Date.parse(headCommittedDate ?? "");
	const ageMinutes = Number.isNaN(committedMs)
		? null
		: (now - committedMs) / 60000;

	for (const path of trackedPaths) {
		const run = latest.get(path);
		if (!run) {
			// Absence is only meaningful once the grace window has passed AND we
			// know how old the head is. An unparseable commit date is missing
			// information, not a dropped dispatch.
			if (ageMinutes === null) unknownWorkflows.push(path);
			else if (ageMinutes >= graceMinutes) absentWorkflows.push(path);
			else pendingWorkflows.push(path);
			continue;
		}
		if (run.status !== "completed") {
			pendingWorkflows.push(path);
			continue;
		}
		if (!Array.isArray(run.jobs)) {
			// A failed run whose jobs we could not read is exactly the case where
			// starved and genuinely-red are indistinguishable. Say so.
			if (STARVED_RUN_CONCLUSIONS.has(run.conclusion)) unknownWorkflows.push(path);
			continue;
		}
		if (isStarvedRun(run)) starvedRuns.push(run);
	}

	let classification = RUN_HEALTH.NORMAL;
	if (starvedRuns.length > 0) classification = RUN_HEALTH.STARVED;
	else if (absentWorkflows.length > 0) classification = RUN_HEALTH.ABSENT;
	else if (unknownWorkflows.length > 0) classification = RUN_HEALTH.UNKNOWN;
	else if (pendingWorkflows.length > 0) classification = RUN_HEALTH.PENDING;

	return {
		classification,
		starvedRuns,
		absentWorkflows,
		unknownWorkflows,
		pendingWorkflows,
		ageMinutes,
	};
}

function normalizeRun(run) {
	return {
		id: run.id,
		path: run.path,
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
		runAttempt: run.run_attempt,
		url: run.html_url,
		createdAt: run.created_at,
		jobs: null,
	};
}

/**
 * Read the head's runs, then the jobs of any run that concluded failed.
 * Bounded by construction: one runs call per PR head, plus one jobs call per
 * FAILED tracked run (the anomalous minority), never per healthy run.
 *
 * Never throws: every failure is recorded and leaves the affected run's
 * `jobs` at null, which the classifier reads as UNKNOWN rather than as
 * evidence of anything.
 */
export async function fetchHeadRunHealth(
	fetcher,
	owner,
	repo,
	headSha,
	headCommittedDate,
	now,
) {
	const errors = [];
	if (!headSha) {
		return {
			health: {
				classification: RUN_HEALTH.UNKNOWN,
				starvedRuns: [],
				absentWorkflows: [],
				unknownWorkflows: [...TRACKED_WORKFLOW_PATHS],
				pendingWorkflows: [],
				ageMinutes: null,
			},
			errors: ["head SHA unavailable; run health not readable"],
		};
	}
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	let runs = [];
	try {
		const response = await fetcher(
			`${base}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
			{ headers: { accept: "application/vnd.github+json" } },
		);
		if (!response.ok) {
			errors.push(`runs read for ${headSha} -> HTTP ${response.status}`);
		} else {
			const payload = await response.json();
			const list = payload?.workflow_runs;
			if (!Array.isArray(list))
				errors.push(`runs read for ${headSha} returned no workflow_runs array`);
			else runs = list.map(normalizeRun);
		}
	} catch (error) {
		errors.push(
			`runs read for ${headSha} -> ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// An errored runs read must not masquerade as "no runs exist" (shape 10),
	// which would classify a readable-but-unreachable head as ABSENT and post a
	// loud dropped-dispatch comment on every open PR during an API outage.
	if (errors.length > 0) {
		return {
			health: {
				classification: RUN_HEALTH.UNKNOWN,
				starvedRuns: [],
				absentWorkflows: [],
				unknownWorkflows: [...TRACKED_WORKFLOW_PATHS],
				pendingWorkflows: [],
				ageMinutes: null,
			},
			errors,
		};
	}

	for (const run of runs) {
		if (!TRACKED_WORKFLOW_PATHS.includes(run.path)) continue;
		if (run.status !== "completed") continue;
		if (!STARVED_RUN_CONCLUSIONS.has(run.conclusion)) continue;
		try {
			const response = await fetcher(
				`${base}/actions/runs/${run.id}/jobs?per_page=100`,
				{ headers: { accept: "application/vnd.github+json" } },
			);
			if (!response.ok) {
				errors.push(`jobs read for run ${run.id} -> HTTP ${response.status}`);
				continue;
			}
			const payload = await response.json();
			run.jobs = Array.isArray(payload?.jobs) ? payload.jobs : null;
			if (run.jobs === null)
				errors.push(`jobs read for run ${run.id} returned no jobs array`);
		} catch (error) {
			errors.push(
				`jobs read for run ${run.id} -> ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		health: classifyHeadRun({ runs, headCommittedDate, now }),
		errors,
	};
}

/** Per-head dedupe key for the absent-run comment. */
export function absentRunCommentMarker(headSha) {
	return `<!-- warden:absent-run:${headSha} -->`;
}

export function absentRunCommentBody(headSha, workflows, ageMinutes) {
	const age =
		ageMinutes === null ? "an unknown time" : `${Math.round(ageMinutes)} minutes`;
	return [
		"**Merge-train warden: GitHub never dispatched CI for this head.**",
		"",
		`No run exists for ${workflows.map((w) => `\`${w}\``).join(" or ")} on \`${headSha}\`, ${age} after the head commit. The \`pull_request\` dispatch was dropped.`,
		"",
		"The required checks here are ABSENT, not passing. Nothing may read this PR as green until a run exists and concludes.",
		"",
		"The warden cannot push, so it cannot recover this itself. Re-dispatch with an empty commit on the branch, or close and reopen the PR.",
		"",
		absentRunCommentMarker(headSha),
	].join("\n");
}

/**
 * Decide the recovery actions for one head's run health. Pure, like
 * `decideActions`: the caller resolves whether the absent-run comment already
 * exists and hands in the boolean.
 *
 * Rerun idempotence uses GitHub's OWN per-head counter, `run_attempt`, rather
 * than a hand-maintained ledger the warden would have to keep in sync. A run
 * the warden has already re-run reports attempt 2, so the rerun branch cannot
 * fire twice for the same run — and a run that is STILL starved on attempt 2
 * is a real outage, recorded as a non-benign error so the warden's own run
 * goes red and the stall is visible within one cycle.
 */
export function decideRunHealthActions(pr, health, { absentCommentExists } = {}) {
	const actions = [];
	for (const run of health.starvedRuns ?? []) {
		if ((run.runAttempt ?? 1) > 1) {
			actions.push({
				type: "note",
				benign: false,
				message: `PR #${pr.number}: ${run.path} run ${run.id} is STARVED again on attempt ${run.runAttempt}; the warden already re-ran it once for this head`,
			});
			continue;
		}
		actions.push({
			type: "rerun-run",
			runId: run.id,
			workflowPath: run.path,
		});
	}
	if ((health.absentWorkflows ?? []).length > 0) {
		if (absentCommentExists) {
			actions.push({
				type: "note",
				benign: true,
				message: `PR #${pr.number}: dispatch still absent for ${health.absentWorkflows.join(", ")}; comment already posted for head ${pr.headSha}`,
			});
		} else {
			actions.push({
				type: "comment",
				body: absentRunCommentBody(
					pr.headSha,
					health.absentWorkflows,
					health.ageMinutes,
				),
			});
		}
	}
	return actions;
}
