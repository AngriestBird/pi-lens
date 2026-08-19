/**
 * Per-session budget for the managed-tool version refresh (#1730).
 *
 * Deliberately its own module, with no imports. `runtime-session.ts` has to
 * call `resetManagedToolRefreshSession` from `handleSessionStart` — the seam
 * the session-state conformance suite walks — and importing
 * `managed-tool-refresh.ts` for it would drag the 4k-line installer registry
 * onto the `session_start` path. The refresh module itself is loaded lazily,
 * 30 seconds later, by the background timer that actually needs it.
 *
 * The counter is what stops one session from spawning 22 `npm update` calls.
 * It is NOT the cooldown: the real cadence lives in the persisted per-tool
 * stamp, so a process that restarts between every refresh still refreshes each
 * tool at most once a week. Resetting this counter only restores the session's
 * right to ASK.
 */

let refreshesThisSession = 0;

/** Refresh attempts made in the current session, successful or not. */
export function managedToolRefreshesThisSession(): number {
	return refreshesThisSession;
}

/** Count one attempt. Called before the spawn, so a failure still spends it. */
export function noteManagedToolRefreshAttempt(): void {
	refreshesThisSession += 1;
}

/**
 * Restore the session's refresh budget. Wired into `handleSessionStart`: the
 * budget is a per-SESSION allowance, and a process that serves many sessions
 * must get a fresh one each time rather than refreshing one tool at launch and
 * never looking again (the #1266/#1490/#1497/#1535 process-lifetime-latch
 * shape). Also used directly by tests.
 */
export function resetManagedToolRefreshSession(): void {
	refreshesThisSession = 0;
}
