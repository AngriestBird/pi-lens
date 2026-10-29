/**
 * The one store shape for state a SESSION owns and a process holds (#4965,
 * defect shape 72).
 *
 * Three stores hand-rolled the same partition: a map keyed by session id whose
 * entry is dropped when that session ends and whose whole table is dropped
 * when the primary resets (`TurnWarningsBySession` in the runtime coordinator,
 * `attributionBySession` and `prefixHashBySession` in `cache-observability.ts`).
 * Each one re-decided retirement and reset, so a fourth store could leave
 * either out unnoticed. This class states both once:
 *
 * - {@link retire}: that session ended (its `session_shutdown`), or its turn
 *   drained the entry. Other sessions' entries are untouched.
 * - {@link clear}: the primary's reset. It drops every session's entry, as
 *   each hand-rolled reset did.
 *
 * `tests/support/session-state-registry.ts` names the owner key of every
 * session-state entry; `tests/clients/session-state-conformance.test.ts`
 * requires a `session`-owned entry to be built on this class or to carry a
 * stated exception.
 */

import { BoundedFifoMap, BoundedLruCache } from "./bounded-cache.js";

export interface SessionKeyedStoreOptions {
	/**
	 * Most sessions held at once; the oldest goes first past it. Omit for a
	 * store whose entries are always retired at the session's shutdown.
	 */
	maxSessions?: number;
	/** `lru`: a read or write moves the session to newest. `fifo` (default): neither does. */
	recency?: "fifo" | "lru";
}

export class SessionKeyedStore<V> {
	private readonly bySession: BoundedFifoMap<string, V>;

	constructor(options: SessionKeyedStoreOptions = {}) {
		const max = options.maxSessions ?? Number.POSITIVE_INFINITY;
		this.bySession =
			options.recency === "lru"
				? new BoundedLruCache<string, V>(max)
				: new BoundedFifoMap<string, V>(max);
	}

	get(sessionId: string): V | undefined {
		return this.bySession.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.bySession.has(sessionId);
	}

	set(sessionId: string, value: V): void {
		this.bySession.set(sessionId, value);
	}

	/** The session's entry, created by `init` on first use. */
	getOrCreate(sessionId: string, init: () => V): V {
		const existing = this.bySession.get(sessionId);
		if (existing !== undefined) return existing;
		const created = init();
		this.bySession.set(sessionId, created);
		return created;
	}

	/** That session's end: drop its entry and no other. */
	retire(sessionId: string): boolean {
		return this.bySession.delete(sessionId);
	}

	/** The primary's reset: drop every session's entry. */
	clear(): void {
		this.bySession.clear();
	}

	get size(): number {
		return this.bySession.size;
	}
}
