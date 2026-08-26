/**
 * The two spawn results a `maxOutputBytes` cap can actually produce (#2100).
 *
 * `safe-spawn.ts`'s `stopForOutputLimit` SIGTERMs the child the moment the
 * retained bytes reach the cap, so the dominant result is a SIGNAL failure that
 * happens to carry `outputTruncated` — not the clean-status pairing four
 * hand-written mocks in this tree assumed. The rarer second shape is a fast
 * tool that exited on its own before the SIGTERM landed. Both are pinned
 * against a live spawn in `tests/clients/safe-spawn-ambient-signal.test.ts`;
 * change them here only when that real-binary test says the runtime moved.
 */

import {
	SpawnFailureError,
	type SpawnResult,
} from "../../clients/safe-spawn.js";

/** The cap hit, safe-spawn killed the tree, the SIGTERM landed. */
export function capKilledSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Process killed by signal: SIGTERM");
	return {
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGTERM",
		error: cause,
		failure: "signal",
		spawnFailure: new SpawnFailureError("killed", cause.message, cause),
		outputTruncated: true,
		...overrides,
	};
}

/** The cap hit, but the tool exited on its own before the SIGTERM landed. */
export function capFastExitSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	return {
		stdout: "",
		stderr: "",
		status: 0,
		outputTruncated: true,
		...overrides,
	};
}

/**
 * The cap hit AND the run then timed out — `outputTruncated` rides along under
 * a timeout failure, so a truncation guard must not claim this one.
 */
export function capThenTimedOutSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Process timed out after 30000ms");
	return {
		stdout: "",
		stderr: "",
		status: null,
		error: cause,
		failure: "timeout",
		spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
		outputTruncated: true,
		...overrides,
	};
}

/** The cap hit AND the run was then aborted. Same rule as the timeout shape. */
export function capThenAbortedSpawnResult(
	overrides: Partial<SpawnResult> = {},
): SpawnResult {
	const cause = new Error("Spawn aborted");
	return {
		stdout: "",
		stderr: "",
		status: null,
		error: cause,
		failure: "aborted",
		spawnFailure: new SpawnFailureError("killed", cause.message, cause),
		outputTruncated: true,
		...overrides,
	};
}
