/**
 * Capture-generation-before-await, check-after — as one primitive (#1754).
 *
 * The shape: a write that follows an `await` must prove the world it captured
 * still exists. A session reset, a cache refresh, or a newer request for the
 * same key can land while the write's producer is in flight, and the late
 * write then publishes an answer the caller no longer wants — or, in the
 * eviction direction, deletes an entry a SUCCESSOR already installed.
 *
 * This module was extracted after the pattern was hand-rolled four times and
 * its absence was a review finding twice:
 *
 * - `clients/dispatch/runners/utils/runner-helpers.ts` held the guarded form
 *   at one site and the unguarded form at another IN THE SAME FILE; #1674's
 *   F5 round copied the guard by hand to three more write sites.
 * - `clients/lsp/client.ts`'s per-(path, identifier) pull sequences (#1682),
 *   whose first guard was vacuous until a review round bound it.
 * - `clients/lsp/workspace-diagnostics-cache.ts`'s per-cwd epochs (#1669),
 *   where the epoch guarded `persist()` but not `lookup()`.
 * - `clients/review-graph/builder.ts`'s workspace-cache epoch, the shape the
 *   one above was modelled on.
 *
 * Two things every one of those needed and at least one got wrong:
 *
 * 1. The check must run at WRITE time, not only at capture time.
 * 2. The stale branch must be OBSERVABLE. A silently dropped write looks
 *    exactly like a write that never happened, which is why the vacuous
 *    guards survived review. `guardedWrite` emits one bounded degradation
 *    record per (source, subject) with the count of repeats, so a dogfood
 *    session can tell "the guard is working" from "the guard never fires".
 *
 * ## Scope and lifetime
 *
 * A `GenerationSource` is a plain counter owned by the RESETTING SEAM — the
 * function that already clears the state the generation protects. This module
 * holds no session state of its own: sources live in the modules that create
 * them, and their reset policy is that module's declaration in
 * `tests/support/session-state-registry.ts`. The only module-level state here
 * is the name registry below, which exists so the #1754 sweep can ask "which
 * stores declare a generation" instead of guessing from identifier names.
 *
 * ## Cost
 *
 * `isCurrent()` is one `Map.get` (keyed sources) or one field read (unkeyed)
 * plus a numeric compare. The key is normalized ONCE at capture, so a handle
 * checked per file in a sweep loop is cheaper than the hand-rolled form it
 * replaces, which re-normalized on every call.
 */

import { incrementDegradationCount } from "./degradation-ledger.js";

/**
 * Names of every generation-carrying store created through this module.
 *
 * Registration is by CONSTRUCTION: you cannot make a `GenerationSource`
 * without appearing here. `tests/clients/generation-guard-sweep.test.ts`
 * reads this to enforce the ratchet — a file that hand-rolls the pattern
 * instead of declaring it here must carry an explicit exemption reason.
 *
 * Process-lifetime and bounded: names are compile-time literals from module
 * initialization, so this cannot grow with workload.
 */
const declaredSources = new Set<string>();

const MAX_DECLARED_SOURCES = 128;

function declare(name: string): string {
	if (!name.trim()) {
		throw new Error("generation source needs a non-empty name");
	}
	if (declaredSources.size < MAX_DECLARED_SOURCES) declaredSources.add(name);
	return name;
}

/** Every generation-carrying store name declared this process. */
export function listDeclaredGenerationSources(): string[] {
	return [...declaredSources].sort();
}

/**
 * A handle on one captured generation.
 *
 * Created before the await; consulted after it. `isCurrent()` is the raw
 * question; `guardedWrite` is the answer plus the telemetry, and is what
 * write sites should use unless they need to branch on staleness for some
 * reason other than skipping the write.
 */
export interface GenerationHandle {
	/** The generation observed at capture time. */
	readonly generation: number;
	/** True while the source has not advanced past the captured generation. */
	isCurrent(): boolean;
	/**
	 * Run `write` only if the captured generation is still current.
	 *
	 * Returns the write's value, or `undefined` when the write was dropped.
	 * A drop is recorded once per (source, subject) with a repeat count —
	 * `subject` must therefore identify WHAT was dropped (the cwd, the tool,
	 * the file), never a bare constant, or the ledger loses the discriminating
	 * identity that makes it useful.
	 */
	guardedWrite<T>(subject: string, write: () => T): T | undefined;
}

/** A single monotonic counter owned by one resetting seam. */
export interface GenerationSource {
	readonly name: string;
	/** The current generation. */
	current(): number;
	/** Advance the generation, invalidating every outstanding handle. */
	bump(): number;
	/** Capture the current generation for a write that follows an await. */
	capture(): GenerationHandle;
}

/**
 * A per-key family of counters, for stores whose invalidation is scoped to
 * one cwd, one document, or one (path, source) pair rather than the whole
 * process.
 *
 * Bounded. Eviction FAILS CLOSED: an evicted key reads as generation 0, so
 * every handle captured at a non-zero generation for that key reports stale
 * and drops its write. Dropping a write is the same outcome the caller takes
 * on a real reset, so the bound costs correctness nothing — only work.
 */
export interface GenerationMap {
	readonly name: string;
	current(key: string): number;
	bump(key: string): number;
	capture(key: string): GenerationHandle;
	/**
	 * Forget one key. The next read starts again at generation 0.
	 *
	 * For stores that RETIRE a key outright — `retirePullSource` in
	 * `clients/lsp/client.ts` is the shape — rather than invalidating it.
	 */
	forget(key: string): void;
	/** Number of keys currently retained, for tests and bound assertions. */
	size(): number;
}

function recordStaleWrite(
	sourceName: string,
	subject: string,
	captured: number,
	observed: number,
): void {
	incrementDegradationCount({
		kind: "generation-guard-stale-write",
		subject: `${sourceName}:${subject}`,
		reason: `write dropped: captured generation ${captured}, current ${observed}`,
	});
}

function makeHandle(
	sourceName: string,
	generation: number,
	read: () => number,
): GenerationHandle {
	return {
		generation,
		isCurrent(): boolean {
			return read() === generation;
		},
		guardedWrite<T>(subject: string, write: () => T): T | undefined {
			const observed = read();
			if (observed !== generation) {
				recordStaleWrite(sourceName, subject, generation, observed);
				return undefined;
			}
			return write();
		},
	};
}

/**
 * Create a counter for a store invalidated as a whole.
 *
 * `name` appears in the stale-write ledger subject and in the sweep's
 * declaration list, so it must name the STORE, not the module.
 */
export function createGenerationSource(name: string): GenerationSource {
	declare(name);
	let generation = 0;
	const read = (): number => generation;
	return {
		name,
		current: read,
		bump(): number {
			generation += 1;
			return generation;
		},
		capture(): GenerationHandle {
			return makeHandle(name, generation, read);
		},
	};
}

const DEFAULT_MAX_KEYS = 512;

export interface GenerationMapOptions {
	/**
	 * Normalize keys before use — pass the same normalizer the guarded store
	 * uses for its own map, or two spellings of one cwd get two counters.
	 */
	normalizeKey?: (key: string) => string;
	/** Retained-key ceiling. Eviction fails closed; see `GenerationMap`. */
	maxKeys?: number;
}

/**
 * Create a per-key family of counters.
 *
 * Use this when invalidation is scoped: a cache refresh for ONE cwd must not
 * drop an in-flight write for another, and a newer pull request for one
 * (path, source) pair must not invalidate a different pair's.
 */
export function createGenerationMap(
	name: string,
	options: GenerationMapOptions = {},
): GenerationMap {
	declare(name);
	const normalize = options.normalizeKey ?? ((key: string): string => key);
	const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
	// Insertion-ordered: the oldest key is evicted first. Re-bumping a key
	// refreshes its position so a hot cwd is not evicted by a burst of
	// one-shot ones.
	const generations = new Map<string, number>();
	const read = (key: string): number => generations.get(key) ?? 0;

	return {
		name,
		current(key: string): number {
			return read(normalize(key));
		},
		bump(key: string): number {
			const normalized = normalize(key);
			const next = read(normalized) + 1;
			generations.delete(normalized);
			generations.set(normalized, next);
			while (generations.size > maxKeys) {
				const oldest = generations.keys().next().value;
				if (oldest === undefined) break;
				generations.delete(oldest);
			}
			return next;
		},
		capture(key: string): GenerationHandle {
			const normalized = normalize(key);
			return makeHandle(`${name}[${normalized}]`, read(normalized), () =>
				read(normalized),
			);
		},
		forget(key: string): void {
			generations.delete(normalize(key));
		},
		size(): number {
			return generations.size;
		},
	};
}

/**
 * Capture the generation, run `fn`, and hand it the handle.
 *
 * Sugar for the common `const handle = source.capture(); ... await ...;
 * handle.guardedWrite(...)` sequence. Use `capture()` directly when the
 * handle must outlive the function that made it — an eviction guard in a
 * `.finally()` is the usual case.
 */
export async function withGeneration<T>(
	source: Pick<GenerationSource, "capture">,
	fn: (handle: GenerationHandle) => Promise<T>,
): Promise<T> {
	return fn(source.capture());
}
