/**
 * Cascade neighbour-budget sizing (#1462).
 *
 * The flat neighbour cap (40) and the turn-end settle wait (5000 ms) used to be
 * set in two different files with nothing relating them. Dogfood 2026-08-15
 * measured what that costs: n=50 cascades, median 30 ms, max 3.88 s at nbr=40 —
 * and with a `reverse_deps_cache` refresh ahead of the graph build (2046 ms for
 * `logger.ts`) the run overran the settle cap, so `cascade_settle_wait` returned
 * `settled: 0` and the whole run was carried instead of delivering anything. The
 * distribution is strongly bimodal, so a flat cap spends its entire budget on
 * exactly the high-fanout runs least likely to land in time.
 *
 * Both knobs live here now, with the derivation that ties them together: size
 * the walk from the settle time the run has NOT already spent. The floor is the
 * inversion guard — a nearly-spent window narrows the walk, it never starves it.
 */

import { toPositiveFinite } from "./env-utils.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";

/**
 * Bounded wait for the turn's deferred cascade computes (#450) to settle before
 * they are merged at turn_end. A late compute is carried over to the next
 * turn_end, never dropped.
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
 * The flat per-run cap: the most neighbours a cascade walks when the settle
 * window is wide open. Still the ceiling — the derivation below only ever
 * narrows it.
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

export interface CascadeBudgetDecision {
	/** Neighbours this run may walk — the budget in force. */
	budget: number;
	/** The flat cap. `budget < ceiling` means time pressure narrowed the walk. */
	ceiling: number;
	/** Settle window left when the walk was sized; negative means overspent. */
	remainingMs: number;
}

/**
 * Size one run's neighbour walk against the settle time it has left.
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
	ceiling?: number;
	floor?: number;
	perNeighbourMs?: number;
}): CascadeBudgetDecision {
	const ceiling = options.ceiling ?? CASCADE_NEIGHBOUR_BUDGET;
	// The floor can never exceed the ceiling — a floor above the cap would make
	// the derived budget LARGER than the flat one it exists to bound.
	const floor = Math.min(ceiling, options.floor ?? neighbourFloor());
	const settleWaitMs = options.settleWaitMs ?? cascadeSettleWaitMs();
	const perNeighbourMs = options.perNeighbourMs ?? neighbourCostMs();
	const elapsedMs = toPositiveFinite(options.elapsedMs);
	const remainingMs = settleWaitMs - elapsedMs;

	// A disabled settle wait means turn_end never blocks on this run: it lands
	// next turn either way (`beginTurn`'s carry-over), so there is no window to
	// fit inside and no reason to narrow the walk.
	if (settleWaitMs <= 0) return { budget: ceiling, ceiling, remainingMs };

	const affordable = Math.floor(remainingMs / perNeighbourMs);
	return {
		budget: Math.min(ceiling, Math.max(floor, affordable)),
		ceiling,
		remainingMs,
	};
}
