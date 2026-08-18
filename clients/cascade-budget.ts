/**
 * Cascade neighbour-budget sizing (#1462).
 *
 * The flat neighbour cap (40) and the turn-end settle wait (5000 ms) were set in
 * two different files with nothing relating them. Dogfood 2026-08-15 measured
 * what that costs: n=50 cascades, median 30 ms, max 3.88 s at nbr=40 — and with
 * a `reverse_deps_cache` refresh ahead of the graph build (2046 ms for
 * `logger.ts`) the run overran the turn_end cap, so `cascade_settle_wait`
 * returned `settled: 0` and the finding arrived a turn late.
 *
 * ## What a slow run actually costs
 *
 * It is NOT lost. `RuntimeCoordinator.settleCascadeRuns` re-parks a promise
 * still in flight at the cap, `agent_settled` gives it a second and more
 * generous drain (`cascade_carry_over_settle`, `quietWindowWaitMs`, 15 000 ms),
 * and `beginTurn` deliberately keeps `_pendingCascadeRuns` so anything still
 * running surfaces at a later turn_end — that is #1443, and pre-#450 these
 * findings were always awaited. So the real trade is:
 *
 *   full neighbour set, one turn late   vs.   a narrowed set, on time,
 *                                             with the remainder lost for good
 *
 * Narrowing is therefore only worth paying for when it genuinely converts a
 * late run into an on-time one. That gives three zones, and the derivation
 * below is exactly those three:
 *
 *   fits         the full walk still fits the on-time window — nothing to do
 *   narrowed     the RESCUE BAND: the full walk no longer fits but a shorter
 *                one does, so trading the tail for on-time delivery buys
 *                something real
 *   past-rescue  not even a floor-sized walk fits any more, so narrowing would
 *                drop neighbours permanently AND still miss the window. Keep
 *                the full budget and let the carry-over deliver it complete.
 *                This is the cold-session case: a fresh graph build measures up
 *                to ~19 s (see `runtime-coordinator.ts`'s carry-over note), and
 *                a floor-sized stub there is strictly worse than pre-#1462.
 *
 * One more guard, for the same reason. If the on-time window could not fit a
 * full walk even at zero prelude, there is no LATE run to rescue — every
 * cascade would be permanently downsized because a *wait* was configured small.
 * That is a budget change wearing a timeout's clothes, so the derivation stands
 * down entirely (`no-rescue-window`) and the flat cap applies. This is what
 * keeps `PI_LENS_CASCADE_SETTLE_WAIT_MS` from doubling as a neighbour-count
 * knob: at the 5000/100/40 defaults the band is a prelude of 1.0–4.5 s, and
 * shrinking the wait to 1000 ms disables narrowing rather than capping every
 * cascade at ~10 neighbours.
 */

import { toPositiveFinite } from "./env-utils.js";
// The knobs only, never the scheduler: `quiet-window.ts` pulls
// `resource-sampler.ts` → `pidusage` at import time, and this module sits on
// the dispatch load path (#1462 review N4).
import {
	isQuietWindowEnabled,
	quietWindowWaitMs,
} from "./quiet-window-config.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";

/**
 * Bounded wait for the turn's deferred cascade computes (#450) to settle before
 * they are merged at turn_end. A late compute is carried over, never dropped.
 *
 * `0` is a meaningful setting (never block turn_end), so this deliberately does
 * NOT use `lazyEnvNumber` — that helper treats 0 as "unset" and would silently
 * restore the 5000 ms default.
 */
export function cascadeSettleWaitMs(): number {
	const raw = Number(process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

/** The budget floor, and the minimum any env override of the cap can produce. */
const MIN_NEIGHBOUR_BUDGET = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

/**
 * The flat per-run cap: the most neighbours a cascade walks. Still the ceiling
 * — the derivation below only ever narrows it, and only inside the rescue band.
 */
export const CASCADE_NEIGHBOUR_BUDGET = Math.max(
	MIN_NEIGHBOUR_BUDGET,
	Number.parseInt(process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET ?? "40", 10) ||
		40,
);

/**
 * Marginal wall-clock cost of one more neighbour in the walk, in ms. Calibrated
 * on the 2026-08-15 dogfood tail: 3.88 s at nbr=40 and 3.71 s at nbr=38, both
 * ~97 ms per neighbour. Touches fan out in parallel, so this is the observed
 * marginal cost under LSP contention, not one touch's own latency.
 *
 * It is an ESTIMATE, and the derivation is sensitive to it: if the true cost is
 * materially above this, a walk sized against it still overruns (the rescue
 * fails and the tail was dropped for nothing). `scripts/bench-cascade-budget.mjs
 * --true-cost-ms=<n>` measures that sensitivity directly. Rounded UP from the
 * measurement so the estimate errs toward narrowing less.
 */
const DEFAULT_NEIGHBOUR_COST_MS = 100;

/** Read per call — sized once per cascade run, never on a hot path. */
function neighbourCostMs(): number {
	return (
		toPositiveFinite(process.env.PI_LENS_CASCADE_NEIGHBOUR_COST_MS) ||
		DEFAULT_NEIGHBOUR_COST_MS
	);
}

function neighbourFloor(): number {
	return (
		toPositiveFinite(process.env.PI_LENS_CASCADE_NEIGHBOUR_FLOOR) ||
		MIN_NEIGHBOUR_BUDGET
	);
}

/** Which of the four rules decided this run's budget. */
export type CascadeBudgetZone =
	| "fits"
	| "narrowed"
	| "past-rescue"
	| "no-rescue-window";

export interface CascadeBudgetDecision {
	/** Neighbours this run may walk — the budget in force. */
	budget: number;
	/** The flat cap. `budget < ceiling` means the rescue band narrowed the walk. */
	ceiling: number;
	/** On-time window left when the walk was sized; negative means overspent. */
	remainingMs: number;
	/** Which rule decided it — the whole reason, in one field. */
	zone: CascadeBudgetZone;
	/**
	 * How long the delivery pipeline keeps a slow run alive before it needs a
	 * later turn_end: the turn_end settle plus the `agent_settled` quiet-window
	 * drain. RECORDED, not a divisor — it is why `past-rescue` keeps the full
	 * budget rather than narrowing, and it puts the second window on the record
	 * so a reader of `cascade_result` sees the whole deadline stack instead of
	 * just the 5000 ms one.
	 *
	 * Counts the drain only when it will actually run: `PI_LENS_QUIET_WINDOW=0`
	 * disables the scheduler while `quietWindowWaitMs()` keeps returning its
	 * budget, so reading the budget alone would claim 15 s of drain that no
	 * longer exists (#1462 review N3).
	 */
	deliveryWindowMs: number;
}

/**
 * Size one run's neighbour walk against the on-time window it has left.
 *
 * `elapsedMs` is the run's own age. A deferred cascade starts at the write and
 * the settle wait starts at turn_end, so its age is not literally settle time
 * spent — but the worst case (and the measured one: the 12:09 event dispatched
 * at 12:09:29.245 and its settle wait timed out at 5001 ms with `settled: 0`) is
 * a turn_end that follows the write immediately. Charging the run's own prelude
 * against the window is the conservative read, and it is the only one the
 * compute can observe from where it sits.
 *
 * Every override exists so the derivation can be tested and benchmarked as a
 * pure function; production passes `elapsedMs` alone.
 */
export function deriveCascadeNeighbourBudget(options: {
	elapsedMs: number;
	settleWaitMs?: number;
	quietDrainMs?: number;
	ceiling?: number;
	floor?: number;
	perNeighbourMs?: number;
}): CascadeBudgetDecision {
	const ceiling = options.ceiling ?? CASCADE_NEIGHBOUR_BUDGET;
	// The floor can never exceed the ceiling — a floor above the cap would make
	// the derived budget LARGER than the flat one it exists to bound.
	const floor = Math.min(ceiling, options.floor ?? neighbourFloor());
	const onTimeMs = options.settleWaitMs ?? cascadeSettleWaitMs();
	const perNeighbourMs = options.perNeighbourMs ?? neighbourCostMs();
	const elapsedMs = toPositiveFinite(options.elapsedMs);
	const remainingMs = onTimeMs - elapsedMs;
	const deliveryWindowMs =
		onTimeMs +
		(options.quietDrainMs ??
			(isQuietWindowEnabled() ? quietWindowWaitMs() : 0));
	const full = { budget: ceiling, ceiling, remainingMs, deliveryWindowMs };

	// No on-time window at all, or one too small to ever fit a full walk. There
	// is no late run to rescue here, only every run to shrink — stand down.
	//
	// Boundary, acknowledged rather than special-cased: at exactly
	// `onTimeMs === ceiling * perNeighbourMs` this does not fire and the `fits`
	// zone has zero width, so any prelude at all narrows slightly. Harmless (the
	// budget still lands within one neighbour of the ceiling, and the rescue is
	// genuine at that setting) and not worth a third comparison.
	if (onTimeMs <= 0 || onTimeMs < ceiling * perNeighbourMs) {
		return { ...full, zone: "no-rescue-window" };
	}
	// The full walk still fits. Nothing to buy.
	if (remainingMs >= ceiling * perNeighbourMs) {
		return { ...full, zone: "fits" };
	}
	// Past rescue: not even a floor-sized walk fits, so narrowing would drop the
	// tail permanently and still miss the window. The carry-over delivers the
	// whole set one turn later instead.
	if (remainingMs < floor * perNeighbourMs) {
		return { ...full, zone: "past-rescue" };
	}
	// The rescue band: a shorter walk lands on time.
	return {
		budget: Math.min(
			ceiling,
			Math.max(floor, Math.floor(remainingMs / perNeighbourMs)),
		),
		ceiling,
		remainingMs,
		deliveryWindowMs,
		zone: "narrowed",
	};
}
