/**
 * Quiet-window kill switch and wait budget, split out of `quiet-window.ts` so a
 * caller that only needs the NUMBERS does not have to import the scheduler.
 *
 * `quiet-window.ts` pulls `resource-sampler.ts` for the heartbeat task, which
 * evaluates `pidusage` (a third-party CJS package) at import time. That is fine
 * for the scheduler itself and wrong for a leaf arithmetic module on the
 * dispatch load path — `cascade-budget.ts` reads these two knobs and is
 * imported by both `runtime-turn.ts` and `dispatch/integration.ts` (#1462
 * review N4). This module imports nothing but `env-utils.ts`.
 *
 * `quiet-window.ts` re-exports all three, so every existing importer keeps
 * working and there is still exactly one memo behind `isQuietWindowEnabled`.
 */

import { toPositiveFinite } from "./env-utils.js";

let _enabledCache: boolean | undefined;

/** `PI_LENS_QUIET_WINDOW=0` disables the whole scheduler (no-op, no logging). */
export function isQuietWindowEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_QUIET_WINDOW !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetQuietWindowEnabledForTests(): void {
	_enabledCache = undefined;
}

const DEFAULT_QUIET_WINDOW_WAIT_MS = 15_000;

/**
 * Bounded wait for the quiet-window's own settle attempts (currently just
 * the carried-over cascade drain). Lazy env read, `Number.isFinite`-guarded
 * so a malformed value falls back to the default instead of poisoning
 * `Math.max`/`setTimeout` with `NaN` (see PR #109).
 *
 * This is the task's BUDGET, not a statement that the task runs — it keeps
 * returning the default when `isQuietWindowEnabled()` is false. Callers asking
 * "how long will the pipeline actually keep working on this" must check both.
 */
export function quietWindowWaitMs(): number {
	const raw = toPositiveFinite(process.env.PI_LENS_QUIET_WINDOW_WAIT_MS);
	return raw > 0 ? raw : DEFAULT_QUIET_WINDOW_WAIT_MS;
}
