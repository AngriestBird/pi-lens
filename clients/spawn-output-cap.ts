/**
 * The one reading of `SpawnResult.outputTruncated` (#2100).
 *
 * Its own module for the same reason `ledger-bounds.ts` is: `spawn-outcome.ts`
 * is on the shared runner path that dozens of test files reach with a bare
 * `vi.mock("safe-spawn.js")`, and importing a VALUE from safe-spawn there makes
 * every one of those mocks have to re-export it. This module has no imports, so
 * nobody has to mock it.
 */

/**
 * True when `outputTruncated` is the OUTPUT CAP's own verdict about this run,
 * and not a detail of some other ending.
 *
 * Reaching `maxOutputBytes` makes `stopForOutputLimit` kill the tree, so a
 * capped run normally resolves as a SIGTERM signal failure — or, when the tool
 * beats the signal out the door, as an ordinary exit that still carries the
 * flag. Either way the truncation is what happened to the run, and a caller
 * must read this BEFORE its `spawnFailure`/`failure`/`status` checks or those
 * answer the cap kill first and the truncation guard never speaks.
 *
 * A timeout or an abort can carry `outputTruncated` too — the flag is spread
 * into every resolve branch, and `timedOut`/`aborted` are set unconditionally,
 * so a noisy tool that also hangs hits both. Those endings own their own
 * classification (the tool never finished, for a reason that is not our cap),
 * so they are excluded here rather than reported as truncation.
 *
 * Typed structurally so `SpawnResult` and the runner-level result shapes that
 * re-spell `failure` as their own vocabulary can both use it.
 */
export function truncatedByOutputCap(result: {
	outputTruncated?: boolean;
	failure?: string;
}): boolean {
	if (result.outputTruncated !== true) return false;
	return result.failure !== "timeout" && result.failure !== "aborted";
}
