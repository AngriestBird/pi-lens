/** Monotonic cooperative-work budgeting for event-loop-sensitive bulk work. */

export interface CooperativeDeadline {
	expired(): boolean;
	reset(): void;
}

export function createDeadline(budgetMs: number): CooperativeDeadline {
	const boundedBudget = Math.max(0, budgetMs);
	let startedAt = performance.now();
	return {
		expired: () => performance.now() - startedAt >= boundedBudget,
		reset: () => {
			startedAt = performance.now();
		},
	};
}

export async function yieldIfOverBudget(
	deadline: CooperativeDeadline,
): Promise<boolean> {
	if (!deadline.expired()) return false;
	await new Promise<void>((resolve) => setImmediate(resolve));
	deadline.reset();
	return true;
}

export async function forEachCooperatively<T>(
	items: Iterable<T>,
	fn: (item: T, index: number) => void | Promise<void>,
	options: {
		budgetMs: number;
		shouldContinue?: () => boolean;
		abortMessage?: string;
	},
): Promise<void> {
	const deadline = createDeadline(options.budgetMs);
	let index = 0;
	for (const item of items) {
		if (options.shouldContinue?.() === false) {
			throw new Error(options.abortMessage ?? "cooperative work superseded");
		}
		const result = fn(item, index++);
		if (
			result !== undefined &&
			typeof (result as PromiseLike<void>).then === "function"
		) {
			await result;
		}
		if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
			if (options.shouldContinue?.() === false) {
				throw new Error(options.abortMessage ?? "cooperative work superseded");
			}
		}
	}
}
