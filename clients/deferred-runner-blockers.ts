/**
 * Collect-later runner BLOCKING findings, delivered to the commit gate (#3814).
 *
 * A runner slower than `COLLECT_LATER_THRESHOLD_MS` is deferred off the write
 * path (`dispatcher.ts` -> `deferRunnerFindings`). Its answer reached the agent
 * only as the turn-end late-runner advisory (#3796/#3808) and never entered the
 * state `lens-guard` reads, so a type error a slow runner raised did not stop
 * `git commit` while the same error from a fast runner did.
 *
 * The blocker state the gate reads is `RuntimeCoordinator`'s inline-blocker map
 * (its latch, the turn-end replay, the retire/clear lifecycle). This module
 * only feeds that map from the deferred store; it adds no second store and no
 * second verdict:
 *
 * - the turn-end late-runner lane (`runtime-turn.ts`) records the survivors it
 *   just delivered, through {@link recordDeferredRunnerBlockers};
 * - the commit gate (`evaluateGitGuard`) asks {@link absorbSettledRunnerBlockers}
 *   first, because a commit in the turn after the edit sees an answer that has
 *   settled but no turn end has drained yet.
 *
 * An answer is current or not by the same two shared seams the lane uses, in the
 * same order: `gateFindingsByPathFreshness` (a later edit makes it stale) and
 * `applyPushedFindingPolicy` (inline ignore, stored disposition, rule policy).
 * The lane keeps its own call to both, because the delivery-surface registry
 * pins that evidence to `runtime-turn.ts` beside the tagged push; a fold of the
 * two sites is the follow-up named on #3814.
 *
 * A run still in flight has answered nothing, so it does not gate: refusing every
 * commit while a 5 s+ runner runs would block the agent on nothing it can fix.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { gateFindingsByPathFreshness } from "./advisory-provenance.js";
import {
	claimSettledRunnerFindingsForGate,
	type PendingRunnerFindings,
} from "./dispatch/pending-runner-findings.js";
import { applyPushedFindingPolicy } from "./dispatch/finding-policy.js";
import type { Diagnostic } from "./dispatch/types.js";
import { logLatency } from "./latency-logger.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

/** Runner ids one bounded row names; the counts stay exact. */
const MAX_LOGGED_RUNNER_IDS = 5;

export interface DeferredBlockerRecording {
	/** Findings new to the blocker map (0 = nothing blocking, or a replay). */
	recorded: number;
	runnerIds: string[];
	fileCount: number;
}

/**
 * Record the blocking findings of one settled deferred answer, after the caller
 * applied the freshness gate and the finding policy to it.
 *
 * `bytes` are the file's bytes the policy read: they become the record's
 * content baseline, which is true because the freshness gate just called the
 * answer current.
 */
export function recordDeferredRunnerBlockers(
	runtime: RuntimeCoordinator,
	pending: PendingRunnerFindings,
	survivors: readonly Diagnostic[],
	bytes: Buffer | undefined,
): number {
	const blocking = survivors.flatMap((d) =>
		d.semantic === "blocking" ? [d] : [],
	);
	if (blocking.length === 0) return 0;
	const recorded = runtime.recordDeferredInlineBlockers(
		pending.filePath,
		blocking,
		{
			recordedAtMs: pending.markedAtMs,
			...(bytes
				? {
						contentBaseline: {
							size: bytes.byteLength,
							sha256: createHash("sha256").update(bytes).digest("hex"),
						},
					}
				: {}),
		},
	);
	// Same recompute every recording seam does: the latch re-derives from the map.
	if (recorded > 0) runtime.updateGitGuardStatus(false, "");
	return recorded;
}

function readBytes(filePath: string): Buffer | undefined {
	try {
		return fs.readFileSync(filePath);
	} catch {
		return undefined;
	}
}

/**
 * Judge every settled, not-yet-judged deferred answer for the commit gate and
 * record the blocking survivors. Synchronous and non-draining: the turn-end
 * drain still delivers every answer, including the non-blocking ones.
 */
export function absorbSettledRunnerBlockers(
	runtime: RuntimeCoordinator,
	cwd: string,
): DeferredBlockerRecording {
	const total: DeferredBlockerRecording = {
		recorded: 0,
		runnerIds: [],
		fileCount: 0,
	};
	const files = new Set<string>();
	for (const pending of claimSettledRunnerFindingsForGate()) {
		const findings = pending.result?.diagnostics ?? [];
		if (findings.length === 0) continue;
		const { "late-runner-findings": gate } = gateFindingsByPathFreshness({
			cwd,
			sources: {
				"late-runner-findings": {
					findings,
					scannedAt: pending.markedAtMs,
					citedPath: (finding: Diagnostic) => finding.filePath,
				},
			},
		});
		// Stale answers are the lane's to drop (it records the lost coverage).
		if (gate.live.length === 0) continue;
		const bytes = readBytes(pending.filePath);
		const { kept } = applyPushedFindingPolicy(gate.live, {
			cwd,
			filePath: pending.filePath,
			content: bytes?.toString("utf-8"),
		});
		const recorded = recordDeferredRunnerBlockers(
			runtime,
			pending,
			kept,
			bytes,
		);
		if (recorded === 0) continue;
		total.recorded += recorded;
		files.add(pending.filePath);
		if (
			!total.runnerIds.includes(pending.runnerId) &&
			total.runnerIds.length < MAX_LOGGED_RUNNER_IDS
		) {
			total.runnerIds.push(pending.runnerId);
		}
	}
	total.fileCount = files.size;
	if (total.recorded > 0) {
		// One row per gate consult that recorded something new; a repeat consult
		// finds every answer judged and writes nothing.
		logLatency({
			type: "phase",
			toolName: "git-guard",
			filePath: cwd,
			phase: "deferred_runner_blockers",
			durationMs: 0,
			metadata: {
				site: "commit_gate",
				recorded: total.recorded,
				runnerIds: total.runnerIds,
				fileCount: total.fileCount,
			},
		});
	}
	return total;
}
