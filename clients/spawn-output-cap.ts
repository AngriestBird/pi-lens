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
 * The cap `safeSpawnAsync` applies when a caller passes no `maxOutputBytes`
 * (#3375).
 *
 * Before this existed, an omitted cap meant NO cap: `appendOutput` fell
 * through to `current + text` and grew one JS string until V8 refused the next
 * concatenation with `RangeError: Invalid string length`. That throw is raised
 * inside a stdout/stderr `data` handler, where the awaiting caller's
 * `try`/`catch` cannot reach it, so it left the Pi host as an uncaught
 * exception (field report: Pi 0.86.1, 2026-09-22).
 *
 * 32 MiB is chosen against the tree's own deliberate ceilings, not invented:
 * the most generous explicit cap any caller asks for is 16 MiB
 * (`MAX_GIT_STATUS_OUTPUT_BYTES` in `clients/shared-checkout-guard.ts` and
 * `clients/opaque-mutation-scan.ts`, `MAX_LS_FILES_OUTPUT_BYTES` in
 * `clients/git-tracked-ignore.ts` — a monorepo's whole tracked-file list), and
 * the rest sit at 8 MiB or 64 KiB. Doubling that ceiling means no consumer
 * whose legitimate volume is within the most generous allowance a maintainer
 * has ever justified can be truncated by the DEFAULT, while the retained
 * string stays 16x below V8's max string length (2^29-24 bytes of ASCII), so
 * the concatenation that crashed the host is now unreachable rather than
 * merely less likely. A caller that genuinely needs more passes its own
 * `maxOutputBytes`; it always wins.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * True when `outputTruncated` is the OUTPUT CAP's own verdict about this run,
 * and not a detail of some other ending.
 *
 * A timeout or an abort can carry `outputTruncated` too. Those endings own
 * their own classification, so they are excluded here rather than reported as
 * truncation.
 *
 * Typed structurally so `SpawnResult` and runner-level result shapes that
 * re-spell `failure` can both use it.
 */
export function truncatedByOutputCap(result: {
	outputTruncated?: boolean;
	failure?: string;
}): boolean {
	return (
		result.outputTruncated === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}

/**
 * True when `stopForOutputLimit` started terminating the child.
 *
 * Windows reports that termination as status 1 without a signal or failure,
 * while POSIX commonly reports SIGTERM. This field avoids reconstructing our
 * action from either platform's exit shape.
 */
export function killedForOutputCap(result: {
	killedForOutputCap?: boolean;
	failure?: string;
}): boolean {
	return (
		result.killedForOutputCap === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}
