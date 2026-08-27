import { normalizeMapKey } from "../path-utils.js";

// #2243 item 4 telemetry sink, INJECTED rather than imported. fact-store must
// stay an import leaf: `degradation-ledger` pulls
// `process-singletons → git-tracked-ignore → safe-spawn`, and `safe-spawn`
// imports `degradation-ledger` back, so a direct import here re-enters that
// cycle and, under vitest's mock hoisting, deadlocks module init with a
// "Cannot access 'safeSpawnAsync' before initialization" TDZ. integration.ts
// owns the store and already sits above that cycle, so it wires this to
// `recordDegradationOnce`. Unset (a plain LRU with no telemetry) is a safe
// no-op for the scanner's local store and for tests that never load dispatch.
// #2243 review round 3 (F1): SIX production FactStore instances share this one
// module-scope reporter slot (dispatch/integration.ts, mcp/analyze.ts,
// lens-map.ts, project-diagnostics/scanner.ts, runtime-session.ts's
// session-start call-graph task, mcp/cli.ts). A constant subject collapsed
// their eviction records into one: runtime-session's session-start
// review-graph walk — which runs before any dispatch and floods a store with
// every file in the project — consumed the once-per-session ledger slot, and
// the dispatch store's OWN eviction (the one that actually risks a live
// read-back mid-dispatch) never got its own record. The reporter now carries
// the evicting store's `subject`, so `recordDegradationOnce`'s own
// kind+subject dedupe key discriminates by store — each store gets its own
// once-per-session record.
export type CapacityEvictionReporter = (
	subject: string,
	reason: string,
) => void;
let capacityEvictionReporter: CapacityEvictionReporter | undefined;

export function setFactStoreEvictionReporter(
	reporter: CapacityEvictionReporter | undefined,
): void {
	capacityEvictionReporter = reporter;
}

export function getFactStoreEvictionReporter():
	| CapacityEvictionReporter
	| undefined {
	return capacityEvictionReporter;
}

// #2240: the dispatch store is module-scope in integration.ts, so it lives for
// the whole process, and a review-graph project walk seeds facts for EVERY file
// it visits. Nothing removed an entry except the next dispatch of that same
// path, so a several-hundred-file batch retained one entry per distinct path
// until the heap ran out. Bound the record count the way widget-state.ts bounds
// its file records.
const MAX_FILE_FACT_RECORDS = 1024;
// Pinned records are exempt from capacity eviction. A dispatch reads its
// file's facts back after the runner groups settle (`file.content` misses read as
// empty content, not as "re-derive"), and the fire-and-forget blast-radius
// build runs a whole-project walk against the SAME store meanwhile — plain LRU
// recency would let that walk evict the file being dispatched. Every other holder
// re-derives an evicted fact from disk.
//
// #2243 item 2: a dispatch pins its file at start (`clearFileFactsFor`) and
// releases it at completion (`endDispatchFor`, in the dispatch's finally). The
// pin set therefore tracks dispatches actually IN FLIGHT, not the last N files
// touched.

export interface ReadonlyFactStore {
	getFileFact<T>(filePath: string, factId: string): T | undefined;
	hasFileFact(filePath: string, factId: string): boolean;
	getSessionFact<T>(factId: string): T | undefined;
	hasSessionFact(factId: string): boolean;
}

export class FactStore implements ReadonlyFactStore {
	// Insertion order is eviction order: the oldest-used record is evicted first.
	private readonly fileFacts = new Map<string, Map<string, unknown>>();
	private readonly sessionFacts = new Map<string, unknown>();
	// Pin refcount per file. A file is exempt from capacity eviction while its
	// count is > 0. Refcounted, not a Set, so two overlapping dispatches of the
	// same file both hold the pin until BOTH settle (#2243 item 2).
	private readonly pinnedFiles = new Map<string, number>();

	/**
	 * @param subject Discriminates this store's capacity-eviction telemetry
	 *   from every other production FactStore's (#2243 review round 3, F1).
	 *   Production callers pass a label naming the store (e.g. `"dispatch"`,
	 *   `"runtime-session-call-graph"`); the default is only for call sites
	 *   that never wired a reporter and tests that don't care.
	 */
	constructor(private readonly subject: string = "session-fact-store") {}

	// All file-keyed methods normalize the path internally via normalizeMapKey().
	// Callers always pass raw/resolved paths — normalization is not their concern.

	getFileFact<T>(filePath: string, factId: string): T | undefined {
		return this.touchFileFacts(normalizeMapKey(filePath))?.get(factId) as
			| T
			| undefined;
	}

	setFileFact(filePath: string, factId: string, value: unknown): void {
		const key = normalizeMapKey(filePath);
		let facts = this.touchFileFacts(key);
		if (!facts) {
			facts = new Map();
			this.fileFacts.set(key, facts);
		}
		facts.set(factId, value);
		this.evictColdFileFacts();
	}

	hasFileFact(filePath: string, factId: string): boolean {
		return this.fileFacts.get(normalizeMapKey(filePath))?.has(factId) ?? false;
	}

	/** Drop one file fact without disturbing the file's derived facts.
	 *  Removes the per-file entry too when the deleted fact was its last value. */
	deleteFileFact(filePath: string, factId: string): void {
		const key = normalizeMapKey(filePath);
		const facts = this.fileFacts.get(key);
		if (!facts) return;
		facts.delete(factId);
		if (facts.size === 0) this.fileFacts.delete(key);
	}

	/** Clear facts for one specific file only, and mark the file's dispatch as
	 *  begun. Use at the start of each per-file dispatch call.
	 *  Preserves facts for other files computed in the same turn.
	 *  Normalizes filePath internally — callers pass raw paths.
	 *  Pins the file against capacity eviction until the matching
	 *  {@link endDispatchFor} runs in the dispatch's settle path (#2243 item 2).
	 *  Every `clearFileFactsFor` MUST be paired with an `endDispatchFor`. */
	clearFileFactsFor(filePath: string): void {
		const key = normalizeMapKey(filePath);
		this.fileFacts.delete(key);
		this.pinFile(key);
	}

	/** Pin a file against capacity eviction for the duration of a dispatch,
	 *  WITHOUT clearing its existing facts. Pairs with {@link endDispatchFor}
	 *  exactly like {@link clearFileFactsFor} does.
	 *
	 *  #2243 review round 3 (F5): `clearFileFactsFor`'s clear+re-derive is
	 *  right for a dispatch driven by a fresh edit, but the debounced
	 *  ast-grep warning scan runs ~2s AFTER the inline dispatch for that same
	 *  edit already re-derived every fact for this exact file — a second
	 *  clear there bought nothing but ~51ms of redundant re-parsing across
	 *  all five providers (measured; a warm-cache read is ~1ms). Use this
	 *  where the facts are very likely already fresh: `runProviders` still
	 *  re-derives any fact this file is missing (a genuine miss, e.g. the
	 *  fact was evicted meanwhile), so a read never depends on staleness. */
	beginDispatchFor(filePath: string): void {
		this.pinFile(normalizeMapKey(filePath));
	}

	/** Release the pin a {@link clearFileFactsFor} or {@link beginDispatchFor}
	 *  took for one file's dispatch. Call once per matching call, from the
	 *  dispatch's finally/settle path, so the pin set tracks dispatches
	 *  actually in flight rather than the last N files touched (#2243 item 2). */
	endDispatchFor(filePath: string): void {
		this.unpinFile(normalizeMapKey(filePath));
		this.evictColdFileFacts();
	}

	/** Clear one file's facts WITHOUT pinning. For sequential single-store scans
	 *  (project-diagnostics) that own their store and race no concurrent walk:
	 *  pinning there would exempt every scanned file from the capacity cap and
	 *  defeat it. Normalizes filePath internally. */
	dropFileFacts(filePath: string): void {
		this.fileFacts.delete(normalizeMapKey(filePath));
	}

	/** LRU touch: re-inserting an existing record moves it to the end of the
	 *  eviction order, so a record still in use is not the next victim. */
	private touchFileFacts(key: string): Map<string, unknown> | undefined {
		const facts = this.fileFacts.get(key);
		if (!facts) return undefined;
		this.fileFacts.delete(key);
		this.fileFacts.set(key, facts);
		return facts;
	}

	private pinFile(key: string): void {
		this.pinnedFiles.set(key, (this.pinnedFiles.get(key) ?? 0) + 1);
	}

	private unpinFile(key: string): void {
		const count = this.pinnedFiles.get(key);
		if (count === undefined) return;
		if (count <= 1) this.pinnedFiles.delete(key);
		else this.pinnedFiles.set(key, count - 1);
	}

	/** Drop least-recently-used records past the cap, skipping the files whose
	 *  dispatch pinned them. Pins survive until endDispatchFor or clearAll. */
	private evictColdFileFacts(): void {
		if (this.fileFacts.size <= MAX_FILE_FACT_RECORDS) return;
		for (const key of this.fileFacts.keys()) {
			if (this.pinnedFiles.has(key)) continue;
			this.fileFacts.delete(key);
			this.reportCapacityEviction(key);
			if (this.fileFacts.size <= MAX_FILE_FACT_RECORDS) return;
		}
	}

	// #2243 item 4: the cap silently drops a fact a live dispatch may read back
	// as "" (dispatcher.ts reads `file.content` with `?? ""`). Emit through the
	// injected reporter so the drop is visible in the ledger instead of being
	// inferred from a downstream symptom. integration.ts routes this to
	// `recordDegradationOnce` keyed on THIS store's `subject` (#2243 review
	// round 3, F1), so the ledger's own per-kind+subject dedupe yields exactly
	// ONE record per session PER STORE (re-arming at session_start when the
	// ledger resets) — no latch or generation compare here, so fact-store
	// keeps no session-scoped state to forget to re-arm.
	private reportCapacityEviction(evictedKey: string): void {
		capacityEvictionReporter?.(
			this.subject,
			`file-fact store exceeded ${MAX_FILE_FACT_RECORDS} records; evicted least-recently-used fact for ${evictedKey}`,
		);
	}

	getSessionFact<T>(factId: string): T | undefined {
		return this.sessionFacts.get(factId) as T | undefined;
	}

	setSessionFact(factId: string, value: unknown): void {
		this.sessionFacts.set(factId, value);
	}

	hasSessionFact(factId: string): boolean {
		return this.sessionFacts.has(factId);
	}

	/** Call on session reset only. Clears everything including tool cache and baselines. */
	clearAll(): void {
		this.fileFacts.clear();
		this.sessionFacts.clear();
		this.pinnedFiles.clear();
	}
}
