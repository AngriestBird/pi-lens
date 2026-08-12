/** Resolve a pi event-bus emitter at delivery time, not subscription time. */
export type BusEmitFn = (channel: string, data: unknown) => void;
export type BusEmitGetter = () => BusEmitFn | undefined;

export interface LiveBusEmitter {
	wire(emit: BusEmitFn | undefined): void;
	wireGetter(getter: BusEmitGetter | undefined): void;
	get(): BusEmitFn | undefined;
	reset(): void;
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
		get() {
			return getter?.() ?? emit;
		},
		reset() {
			emit = undefined;
			getter = undefined;
		},
	};
}
