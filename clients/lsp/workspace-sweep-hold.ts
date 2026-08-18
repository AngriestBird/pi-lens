/**
 * #1618: a full workspace sweep (`LSPService.runWorkspaceDiagnostics`, the
 * engine behind `lens_diagnostics mode=full`) grants itself a wall-clock
 * ceiling (`FULL_SCAN_WALL_CLOCK_MS`, see {@link getFullScanWallClockMs})
 * that can outlive the detached LSP idle-reset timer armed by
 * `clients/runtime-turn.ts`'s `handleTurnEnd` on a file-less turn. Nothing
 * previously stopped that timer from firing mid-sweep and destroying the
 * very service the sweep was actively touching — every file the sweep had
 * not yet reached then failed with zero trace and got mislabeled as budget
 * exhaustion.
 *
 * This module is the shared hold: `runWorkspaceDiagnostics` acquires it for
 * its own lifetime (try/finally, so a throw or an aborted sweep still
 * releases it) and the idle-reset timer consults it before firing. A COUNTER,
 * not a boolean — two overlapping `lens_diagnostics mode=full` calls (or a
 * sweep started while another is still finishing) must each be free to
 * release independently without the other's hold being dropped early, and a
 * leaked hold that never re-arms idle reset is the inverse defect (state
 * that must re-arm cannot hide behind a stuck guard).
 *
 * `getFullScanWallClockMs` also lives here (rather than duplicated between
 * `tools/lens-diagnostics.ts` and `clients/runtime-turn.ts`) so the idle-reset
 * base delay can be DERIVED from the sweep's own ceiling instead of the two
 * constants drifting apart again (#1618 acceptance criterion 6).
 */

let activeSweepCount = 0;
let idleWaiters: Array<() => void> = [];

/**
 * Acquire the hold for one `runWorkspaceDiagnostics` call. Returns a release
 * function; callers MUST call it from a `finally` block so an overlapping or
 * throwing sweep still releases its hold. Idempotent — calling the returned
 * function more than once is a no-op past the first call.
 */
export function acquireWorkspaceSweepHold(): () => void {
	activeSweepCount += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeSweepCount = Math.max(0, activeSweepCount - 1);
		if (activeSweepCount === 0 && idleWaiters.length > 0) {
			const waiters = idleWaiters;
			idleWaiters = [];
			for (const waiter of waiters) {
				try {
					waiter();
				} catch {
					// Best-effort — a waiter failure must never propagate into the
					// releasing sweep's own call stack.
				}
			}
		}
	};
}

/** True while at least one `runWorkspaceDiagnostics` sweep is in flight. */
export function isWorkspaceSweepActive(): boolean {
	return activeSweepCount > 0;
}

/**
 * Run `cb` once the hold count next returns to zero. Runs synchronously and
 * immediately when no sweep is active right now — the common case, and the
 * one every non-sweep idle-reset arm/fire takes.
 */
export function runWhenWorkspaceSweepIdle(cb: () => void): void {
	if (activeSweepCount === 0) {
		cb();
		return;
	}
	idleWaiters.push(cb);
}

/** Test-only: reset the module-scope hold state between tests. */
export function _resetWorkspaceSweepHoldForTests(): void {
	activeSweepCount = 0;
	idleWaiters = [];
}

/**
 * Wall-clock ceiling for one `lens_diagnostics mode=full` scan
 * (`runWorkspaceDiagnostics` plus its concurrent project-runner/analyzer
 * work). Single source for both `tools/lens-diagnostics.ts` (the sweep
 * caller) and `clients/runtime-turn.ts` (the idle-reset timer whose base
 * delay must outlive it) — lazy env read, never memoized, matching this
 * codebase's house style so a test can flip the override mid-run.
 */
export function getFullScanWallClockMs(): number {
	const raw = Number(process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // 5 min default
}
