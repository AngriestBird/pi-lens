/**
 * Shared memoized-import-with-eviction helper (#1570).
 *
 * `x ??= import(...)` looks harmless but caches a REJECTED promise for the
 * process lifetime: once a dynamic import fails (a transient EMFILE, a
 * momentary fs hiccup, a race with a file still being written), every later
 * caller awaits that same rejected promise forever — one bad load poisons
 * the module for the rest of the process. Module loads are cheap, so a
 * rejection should evict the memo immediately and let the next demand
 * retry; no cooldown is needed (unlike a network-backed memo such as the
 * grammar-download retry in #1536, which does need one).
 */
export interface LazyImport<T> {
	/** Start (or reuse) the load. A rejected load evicts itself first, so the
	 * next call retries instead of replaying the same rejection forever. */
	get(): Promise<T>;
	/** Test-only: drop the memo unconditionally, independent of settlement. */
	resetForTests(): void;
}

export function createLazyImport<T>(load: () => Promise<T>): LazyImport<T> {
	let cached: Promise<T> | undefined;
	return {
		get(): Promise<T> {
			return (cached ??= load().catch((err: unknown) => {
				cached = undefined;
				throw err;
			}));
		},
		resetForTests(): void {
			cached = undefined;
		},
	};
}
