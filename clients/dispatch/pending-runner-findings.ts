/** Turn-end handoff for runners moved off the post-write critical path. */

import type { RunnerResult } from "./types.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import type { GenerationHandle } from "../generation-guard.js";

export interface PendingRunnerFindings {
	filePath: string;
	cwd: string;
	projectRoot: string;
	runnerId: string;
	markedAtMs: number;
	writeIndex?: number;
	result?: RunnerResult;
	/**
	 * #3758/#3813: the producer's captured handle, carried through the drain so
	 * a requeued, capacity-held answer stays fenced to the scope that owned it.
	 * `| undefined` so an explicit `session: handle | undefined` at a dispatch
	 * site stays assignable under `exactOptionalPropertyTypes`.
	 */
	session?: GenerationHandle | undefined;
}

interface PendingRunnerPromise extends Omit<PendingRunnerFindings, "result"> {
	promise: Promise<RunnerResult>;
	settled: boolean;
	result?: RunnerResult;
	/** #3758: the dispatch's session; a drain after it retired drops the result. */
	session: GenerationHandle | undefined;
}

const pending: PendingRunnerPromise[] = [];

/** The drain's and the commit gate's one view of a settled entry. */
function settledSnapshot(entry: PendingRunnerPromise): PendingRunnerFindings {
	return {
		filePath: entry.filePath,
		cwd: entry.cwd,
		projectRoot: entry.projectRoot,
		runnerId: entry.runnerId,
		markedAtMs: entry.markedAtMs,
		writeIndex: entry.writeIndex,
		// #3758/#3813: carry the producer's handle so a requeued snapshot keeps
		// the scope that owned it, and the gate's peek can fence with it.
		session: entry.session,
		result: entry.result,
	};
}
const MAX_PENDING_RUNNER_FINDINGS = 50;

export function deferRunnerFindings(
	entry: Omit<PendingRunnerFindings, "result"> & {
		promise: Promise<RunnerResult>;
		/**
		 * #3568: the dispatch's session. session_start clears this store in the
		 * same tick it bumps the generation, so an entry deferred after that is
		 * one the next session's turn end must not drain.
		 */
		session?: GenerationHandle;
	},
): void {
	const { session, ...owned } = entry;
	if (
		session !== undefined &&
		session.guardedWrite(`${entry.runnerId}:${entry.filePath}`, () => true) ===
			undefined
	) {
		void entry.promise.catch(() => undefined);
		return;
	}
	const tracked: PendingRunnerPromise = { ...owned, session, settled: false };
	// Attach exactly once at ownership time. Re-attaching at every turn end
	// accumulates handlers on a promise that may never settle (#2122 F8).
	void tracked.promise.then(
		(result) => {
			tracked.result = result;
			tracked.settled = true;
		},
		(error: unknown) => {
			tracked.result = {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				failureKind: "exception",
				failureMessage: String(error).slice(0, 200),
			};
			tracked.settled = true;
		},
	);
	track(tracked);
}

/**
 * #3813: hand a drained, settled result back for the next turn end because the
 * turn-end cap cut the part that carried it. It re-enters through the same
 * bounded store as a fresh deferral (same cap, same eviction record) and the
 * next drain re-gates it for freshness against its original `markedAtMs`. It
 * carries the producer's captured handle, so the next drain still fences it to
 * the scope that owned the result (#3758); a requeue after that scope retired
 * is dropped with its counted `generation-guard-stale-write` row.
 */
export function requeueRunnerFindings(
	entry: PendingRunnerFindings & { result: RunnerResult },
): void {
	const { result, ...owned } = entry;
	track({
		...owned,
		session: entry.session,
		promise: Promise.resolve(result),
		settled: true,
		result,
	});
}

function track(tracked: PendingRunnerPromise): void {
	pending.push(tracked);
	if (pending.length > MAX_PENDING_RUNNER_FINDINGS) {
		const evicted = pending.shift();
		if (evicted) {
			incrementDegradationCount({
				kind: "runner-findings-evicted",
				subject: `${evicted.runnerId}:${evicted.filePath}`,
				reason: `pending runner cap ${MAX_PENDING_RUNNER_FINDINGS}`,
			});
		}
	}
}

/**
 * Resolve already-finished runner work for this turn. Unfinished work remains
 * owned by the store and is retried at the next turn boundary.
 */
export async function drainPendingRunnerFindings(
	maxWaitMs = 2_000,
): Promise<PendingRunnerFindings[]> {
	if (pending.length === 0) return [];
	const current = pending.splice(0, pending.length);
	const results: PendingRunnerFindings[] = [];
	// Give already-resolved promises one microtask turn without introducing a
	// wall-clock wait. This observes completed work while preserving the F5
	// zero-budget contract for in-flight runners.
	if (maxWaitMs === 0) await Promise.resolve();
	if (maxWaitMs > 0 && current.some((entry) => !entry.settled)) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, maxWaitMs);
			timer.unref?.();
		});
	}
	for (const entry of current) {
		// #3758: a turn end of another session (a concurrent secondary's, in
		// the gap before the next session_start clears this store) must not
		// deliver a retired session's result; the drop leaves the handle's row.
		if (
			entry.session !== undefined &&
			entry.session.guardedWrite(
				`turn-end:${entry.runnerId}:${entry.filePath}`,
				() => true,
			) === undefined
		)
			continue;
		if (entry.settled && entry.result) {
			results.push(settledSnapshot(entry));
		} else {
			pending.push(entry);
		}
	}
	return results;
}

/**
 * #3814: the answers that have settled, WITHOUT removing them: the turn-end
 * drain still owns delivery, so a non-blocking answer the commit gate looked at
 * is not lost. The store keeps no per-entry state for the gate, so a fault while
 * judging one answer cannot leave it unjudged for later attempts (r1 L2). An
 * in-flight run is not returned: it has said nothing yet, and the store still
 * owns it for the turn-end drain.
 */
export function peekSettledRunnerFindings(): PendingRunnerFindings[] {
	return pending.flatMap((entry) =>
		entry.settled && entry.result ? [settledSnapshot(entry)] : [],
	);
}

/** Drop a stale answer and record the lost re-run coverage. */
export function dropStaleRunnerFindings(entry: PendingRunnerFindings): void {
	if (!entry.result) return;
	incrementDegradationCount({
		kind: "runner-findings-stale",
		subject: `${entry.runnerId}:${entry.filePath}`,
		reason: "completed result was older than the latest file edit",
	});
}

export function resetPendingRunnerFindings(): void {
	pending.length = 0;
}

export function pendingRunnerFindingsSize(): number {
	return pending.length;
}
