/**
 * Delivery holds for the turn-end composer (#3813).
 *
 * A producer that marks something delivered (a latch, a drained queue, a
 * "retired after this delivery" record, a delivery counter) must not do it for
 * text `capTurnEndMessage` cuts. `handleTurnEnd` composes first and caps
 * last, so the producer cannot know at compose time; it registers a hold on
 * the part it produced, and the composer settles every hold once, after the
 * cap, against what the message actually kept.
 *
 * A hold carries one of two shapes, never both needed:
 *
 * - peek-then-commit: the producer left its state alone at compose time and
 *   `onDelivered` commits it (the past-EOF retirement, the dependency-drift
 *   count). A cut part commits nothing, so the state is still pending.
 * - drain-then-restore: the producer's state is already drained (a cascade
 *   run, a settled runner result, an auxiliary pair) and `onHeld` puts it
 *   back for the next turn.
 *
 * Reach rule, per part: the part is reached when it lies whole inside the kept
 * prefix, or when its head is kept and it could not fit the cap even as the
 * first part (holding it would pin it forever, so the first delivery is its
 * delivery). A part whose head the cap cut away, or that fits alone yet was
 * cut part-way, is held.
 */

export interface DeliveryHold {
	/** The tier-array entry the hold rides on, as pushed (before any label). */
	part: string;
	/** The whole part reached the message: commit the producer's state. */
	onDelivered?: () => void;
	/** The cap cut the part: put the producer's state back. */
	onHeld?: () => void;
	/**
	 * A counter that only advances on a message the agent actually receives:
	 * not committed when the signature dedupe suppresses the turn (#1950 F1).
	 */
	skipOnSuppressed?: boolean;
}

/** One entry of the composed message: `raw` is what a hold names. */
export interface ComposedPart {
	raw: string;
	text: string;
}

export interface DeliveryHoldPlan {
	/** Parts whose hold the cap cut, known before the message is finalized. */
	heldCount: number;
	/**
	 * Run each hold's callback once. `suppressed` is true when the message is
	 * not sent because it is identical to the last one delivered: its parts are
	 * text the agent already holds, so they settle as delivered.
	 */
	settle(options: {
		suppressed: boolean;
		isCurrentSession: () => boolean;
		onFault: (cause: unknown) => void;
	}): { delivered: number; held: number };
}

export function planDeliveryHolds(args: {
	holds: readonly DeliveryHold[];
	parts: readonly ComposedPart[];
	/** Chars of the `\n\n`-joined message the cap kept. */
	keptChars: number;
	separatorLength: number;
	/** True when `text` passes the cap unchanged as the first part. */
	fitsAlone: (text: string) => boolean;
}): DeliveryHoldPlan {
	const byPart = new Map<string, DeliveryHold[]>();
	for (const hold of args.holds) {
		const queue = byPart.get(hold.part);
		if (queue) queue.push(hold);
		else byPart.set(hold.part, [hold]);
	}
	const settled: Array<{ hold: DeliveryHold; reached: boolean }> = [];
	let start = 0;
	for (const part of args.parts) {
		const end = start + part.text.length;
		const hold = byPart.get(part.raw)?.shift();
		if (hold) {
			const whole = end <= args.keptChars;
			const headOfOversized =
				start < args.keptChars && !args.fitsAlone(part.text);
			settled.push({ hold, reached: whole || headOfOversized });
		}
		start = end + args.separatorLength;
	}
	return {
		heldCount: settled.reduce((n, entry) => n + (entry.reached ? 0 : 1), 0),
		settle: ({ suppressed, isCurrentSession, onFault }) => {
			let delivered = 0;
			let held = 0;
			// A session replaced mid-turn owns none of this state any more.
			const live = isCurrentSession();
			for (const { hold, reached } of settled) {
				if (reached) delivered += 1;
				else held += 1;
				if (!live) continue;
				const run = reached
					? suppressed && hold.skipOnSuppressed
						? undefined
						: hold.onDelivered
					: hold.onHeld;
				if (!run) continue;
				try {
					run();
				} catch (cause) {
					onFault(cause);
				}
			}
			return { delivered, held };
		},
	};
}
