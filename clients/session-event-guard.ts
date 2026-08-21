/**
 * One home for "this event arrived on a ctx the SDK already invalidated"
 * (#1925).
 *
 * pi invalidates a captured extension ctx when the session is replaced —
 * `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.reload()`.
 * Every accessor on that ctx then throws from the SDK's `assertActive()`
 * (`core/extensions/loader.js` in the installed
 * `@earendil-works/pi-coding-agent`). An event already queued when the swap
 * happens still reaches pi-lens, carrying the dead ctx, and the first
 * unguarded `ctx.signal` / `ctx.ui` / `ctx.cwd` read throws.
 *
 * That throw does not escape into pi's loop. `ExtensionRunner.emit` wraps every
 * handler call in a try/catch and routes the error to `emitError`
 * (`core/extensions/runner.js:586-606` in the installed SDK), so the throw
 * surfaces as an extension error report against pi-lens. The report names the
 * wrong cause. It reads as a pi-lens handler bug when the real event is a
 * benign race with a session swap, it says nothing about which handler keeps
 * losing, and it counts nothing. This wrapper converts that noisy misattributed
 * error into a counted, bounded, attributable skip.
 *
 * #1924 fixed that for `agent_settled` with an inline try/catch. #1925 found
 * four more handlers with the same shape. Five inline copies of one policy is
 * the parallel-state defect AGENTS.md names, so the policy lives here instead
 * and every session-event registration in `index.ts` goes through
 * {@link wrapSessionEventHandler}. `agent_settled` is a consumer of this path,
 * not a special case.
 *
 * The wrapper does three things and nothing else:
 *
 * 1. **Probes once, before dispatch.** {@link probeCtxActive} answers `false`
 *    only when an `assertActive()`-wrapped accessor threw the SDK's own stale
 *    message. `undefined` (no ctx, unexpected shape, unrecognised throw) is
 *    inconclusive and always dispatches — never guess a session dead.
 * 2. **Still classifies a stale throw that races in mid-handler.** The probe
 *    is a point-in-time read; the swap can land between the probe and the
 *    handler's own first ctx read, and for an async handler it can land at any
 *    await. Both the synchronous throw and the rejected promise are
 *    classified by {@link isStaleExtensionCtxError}.
 * 3. **Makes the skip visible.** One bounded record and one ledger kind for
 *    the whole class, keyed by the event name so aggregation still answers
 *    WHICH handler is being skipped. A silent guard and a guard that never
 *    fires read identically from a log, which is exactly how vacuous guards
 *    survive review.
 *
 * Anything that is NOT the SDK's stale-ctx error propagates unchanged. The
 * wrapper narrows nothing else: a handler bug must stay as loud as it was.
 */

import { emitBounded } from "./bounded-telemetry.js";
import { probeCtxActive } from "./session-lifecycle.js";

/**
 * The pi SDK invalidates a captured `pi`/command ctx after a session
 * replacement or reload; every later `pi.*` call then throws with this
 * signature. Matched by MESSAGE — not by `===` against a captured instance —
 * so a fire-and-forget task that races a session swap can recognise the benign
 * stale-ctx throw and degrade to a no-op. Substring-matched on the stable
 * "stale after session replacement or reload" phrase so it survives incidental
 * wording changes around it.
 *
 * Deliberately a NARROWER match than {@link probeCtxActive}'s (which accepts
 * the shorter "stale after session replacement", the message
 * `ExtensionRunner.invalidate()` uses for its own probe path). Widening this
 * one is a behavior change: it decides which throws get swallowed.
 */
export function isStaleExtensionCtxError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("stale after session replacement or reload")
	);
}

/** Where the staleness was detected, for the record's metadata. */
type StaleDetectionPoint = "pre-dispatch" | "mid-handler";

/**
 * Record one skipped session event. Bounded per event name: the ledger counts
 * every occurrence exactly, and only the first per event name this session
 * also writes the detailed `latency.log` row, so a replaced session whose
 * queue drains a hundred stale events cannot storm the log.
 */
function recordStaleSkip(
	eventName: string,
	detectedAt: StaleDetectionPoint,
): void {
	emitBounded(
		"session_event_stale_ctx_skip",
		eventName,
		{
			durationMs: 0,
			metadata: { event: eventName, detectedAt },
		},
		{
			ledgerKind: "extension-ctx-stale",
			risingEdgePer: "identity",
			reason: `${eventName} skipped: extension ctx is stale (${detectedAt})`,
		},
	);
}

export interface SessionEventGuardOptions {
	/** pi-lens's debug sink, so a skip is also visible in a dogfood trace. */
	dbg?: (message: string) => void;
}

/** A pi event handler, in the shape `pi.on` delivers. */
type SessionEventHandler = (event: never, ctx: never) => unknown;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof (value as { then?: unknown } | null | undefined)?.then === "function"
	);
}

/**
 * Wrap one `pi.on` handler so a stale ctx becomes an observable no-op instead
 * of a throw into the host.
 *
 * The returned function keeps the handler's own signature and its return
 * value, so a wrapped registration is a drop-in for the bare one. A skipped
 * event resolves to `undefined`, which is what every one of pi-lens's session
 * handlers already returns on its early-exit paths.
 */
export function wrapSessionEventHandler<H extends SessionEventHandler>(
	eventName: string,
	handler: H,
	options: SessionEventGuardOptions = {},
): H {
	const skip = (detectedAt: StaleDetectionPoint): undefined => {
		recordStaleSkip(eventName, detectedAt);
		try {
			options.dbg?.(
				`${eventName} skipped: extension ctx is stale after session replacement or reload`,
			);
		} catch {
			// A debug sink must never decide whether an event is handled.
		}
		return undefined;
	};

	const guarded = (event: never, ctx: never): ReturnType<H> | undefined => {
		// `false` is the only confirmed verdict. `undefined` means the probe
		// could not tell, and an inconclusive probe must dispatch.
		if (probeCtxActive(ctx) === false) return skip("pre-dispatch");
		try {
			const result = handler(event, ctx) as ReturnType<H>;
			if (isThenable(result)) {
				// Recover the rejection in place. The host awaits the same promise
				// it would have awaited anyway; it just resolves instead.
				return Promise.resolve(result).catch((err: unknown) => {
					if (isStaleExtensionCtxError(err)) return skip("mid-handler");
					throw err;
				}) as ReturnType<H>;
			}
			return result;
		} catch (err) {
			if (isStaleExtensionCtxError(err)) return skip("mid-handler");
			throw err;
		}
	};

	return guarded as H;
}
