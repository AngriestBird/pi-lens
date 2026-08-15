import { recordDegradation } from "./degradation-ledger.js";
import { probeCtxActive } from "./session-lifecycle.js";

/** Resolve a pi event-bus emitter and its ctx at delivery time, not
 * subscription time. */
export type BusEmitFn = (channel: string, data: unknown) => void;
export interface BusEmitTarget {
	emit: BusEmitFn;
	ctx: unknown;
}
export type BusEmitGetter = () => BusEmitFn | BusEmitTarget | undefined;
export type BusEmitResolution =
	| { outcome: "ready"; emit: BusEmitFn }
	| { outcome: "unwired" }
	| { outcome: "stale-session" };

export interface LiveBusEmitter {
	wire(emit: BusEmitFn | undefined): void;
	wireGetter(getter: BusEmitGetter | undefined): void;
	resolve(): BusEmitResolution;
	reset(): void;
}

const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement";

/** Ledger a dead activation once, at the publisher's occurrence-window guard. */
export function recordStaleBusFailure(subject: string, error: unknown): void {
	const reason = String(error);
	if (!reason.includes(STALE_CTX_MESSAGE)) return;
	recordDegradation({ kind: "bus-stale", subject, reason });
}

export function createLiveBusEmitter(): LiveBusEmitter {
	let emit: BusEmitFn | undefined;
	let getter: BusEmitGetter | undefined;
	return {
		wire(next) {
			emit = next;
			getter = undefined;
		},
		wireGetter(next) {
			getter = next;
			emit = undefined;
		},
		resolve() {
			// Invoke the getter for every delivery so session_start rewiring can
			// replace a captured pre-await activation with the current primary. When
			// the current target is nevertheless confirmed stale, never invoke it.
			const target = getter?.() ?? emit;
			if (!target) return { outcome: "unwired" };
			if (typeof target === "function") {
				return { outcome: "ready", emit: target };
			}
			if (probeCtxActive(target.ctx) === false) {
				return { outcome: "stale-session" };
			}
			return { outcome: "ready", emit: target.emit };
		},
		reset() {
			emit = undefined;
			getter = undefined;
		},
	};
}
