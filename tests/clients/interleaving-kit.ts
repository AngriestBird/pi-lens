/** Small, deterministic coordination helpers for concurrency tests. */

type SpyLike<T extends (...args: any[]) => any> = {
	mockImplementation(implementation: T): unknown;
};

export type Suspension = {
	admitted: Promise<void>;
	release: () => void;
};

export type WaitForOptions = {
	attempts?: number;
	yieldControl?: () => Promise<void>;
};

/** Poll a condition with a finite number of event-loop turns and no sleeps. */
export async function waitFor<T>(
	read: () => T,
	ready: (value: T) => boolean,
	{ attempts = 5_000, yieldControl = nextTurn }: WaitForOptions = {},
): Promise<T> {
	let value = read();
	for (let attempt = 0; attempt < attempts && !ready(value); attempt++) {
		await yieldControl();
		value = read();
	}
	return value;
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Park calls entering a mocked seam until release is called.
 *
 * `admitted` resolves after the first call has reached the seam. Additional
 * calls remain blocked on the same release, which makes the helper useful for
 * both one yield point and a group of concurrent writers.
 */
export function suspendAt<T extends (...args: any[]) => any>(
	seamSpy: SpyLike<T>,
	implementation?: T,
	options: { calls?: number } = {},
): Suspension {
	let admit!: () => void;
	let unblock!: () => void;
	const admitted = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const released = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	let first = true;
	let calls = 0;

	seamSpy.mockImplementation((async (...args: Parameters<T>) => {
		if (first) {
			first = false;
			admit();
		}
		calls++;
		if (calls <= (options.calls ?? Number.POSITIVE_INFINITY)) await released;
		return implementation
			? await implementation(...args)
			: undefined;
	}) as T);

	return { admitted, release: unblock };
}
