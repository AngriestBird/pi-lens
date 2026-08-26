/** Turn-end handoff for runners moved off the post-write critical path. */

import type { Diagnostic, RunnerResult } from "./types.js";

export interface PendingRunnerFindings {
	filePath: string;
	cwd: string;
	projectRoot: string;
	runnerId: string;
	markedAtMs: number;
	result?: RunnerResult;
}

interface PendingRunnerPromise extends Omit<PendingRunnerFindings, "result"> {
	promise: Promise<RunnerResult>;
	result?: RunnerResult;
}

const pending: PendingRunnerPromise[] = [];
export const MAX_PENDING_RUNNER_FINDINGS = 50;

export function deferRunnerFindings(
	entry: Omit<PendingRunnerFindings, "result"> & {
		promise: Promise<RunnerResult>;
	},
): void {
	pending.push(entry);
	if (pending.length > MAX_PENDING_RUNNER_FINDINGS) pending.shift();
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
	const settled = new Set<PendingRunnerPromise>();
	const results: PendingRunnerFindings[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	for (const entry of current) {
		void entry.promise.then((result) => {
			entry.result = result;
			settled.add(entry);
		});
	}
	await Promise.race([
		Promise.allSettled(current.map((entry) => entry.promise)),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, maxWaitMs);
			timer.unref?.();
		}),
	]);
	if (timer) clearTimeout(timer);
	for (const entry of current) {
		if (settled.has(entry) && entry.result) {
			results.push({
				filePath: entry.filePath,
				cwd: entry.cwd,
				projectRoot: entry.projectRoot,
				runnerId: entry.runnerId,
				markedAtMs: entry.markedAtMs,
				result: entry.result,
			});
		} else {
			pending.push(entry);
		}
	}
	return results;
}

export function resetPendingRunnerFindings(): void {
	pending.length = 0;
}

export function pendingRunnerFindingsSizeForTests(): number {
	return pending.length;
}

export type PendingRunnerDiagnostic = Diagnostic;
