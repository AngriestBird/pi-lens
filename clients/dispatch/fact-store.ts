import { normalizeMapKey } from "../path-utils.js";

// #2240: the dispatch store is module-scope in integration.ts, so it lives for
// the whole process, and a review-graph project walk seeds facts for EVERY file
// it visits. Nothing removed an entry except the next dispatch of that same
// path, so a several-hundred-file batch retained one entry per distinct path
// until the heap ran out. Bound the record count the way widget-state.ts bounds
// its file records.
const MAX_FILE_FACT_RECORDS = 1024;
// Pinned records are exempt from capacity eviction. A dispatch reads its file's
// facts back after the runner groups settle (`file.content` misses read as empty
// content, not as "re-derive"), and the fire-and-forget blast-radius build runs
// a whole-project walk against the SAME store meanwhile — plain LRU recency
// would let that walk evict the file being dispatched. Every other holder
// re-derives an evicted fact from disk. Bounded so the pin set cannot itself
// grow: 16 covers a turn's concurrently dispatched writes.
const MAX_PINNED_FILE_RECORDS = 16;

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
	private readonly pinnedFiles = new Set<string>();

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

	/** Clear facts for one specific file only. Use at the start of each per-file dispatch call.
	 *  Preserves facts for other files computed in the same turn.
	 *  Normalizes filePath internally — callers pass raw paths.
	 *  This call is also what marks the file as being dispatched, so its facts
	 *  are pinned against capacity eviction until 16 later files claim the pin. */
	clearFileFactsFor(filePath: string): void {
		const key = normalizeMapKey(filePath);
		this.fileFacts.delete(key);
		this.pinFile(key);
	}

	/** Clear all file facts across all paths. Reserve for explicit full resets only —
	 *  do NOT use in the normal per-file dispatch path. */
	clearFileFacts(): void {
		this.fileFacts.clear();
		this.pinnedFiles.clear();
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
		this.pinnedFiles.delete(key);
		this.pinnedFiles.add(key);
		while (this.pinnedFiles.size > MAX_PINNED_FILE_RECORDS) {
			const oldest = this.pinnedFiles.values().next().value;
			if (oldest === undefined) break;
			this.pinnedFiles.delete(oldest);
		}
	}

	/** Drop least-recently-used records past the cap, skipping the files whose
	 *  dispatch pinned them. The pin set is bounded well below the cap, so a
	 *  fully pinned store cannot stall eviction. */
	private evictColdFileFacts(): void {
		if (this.fileFacts.size <= MAX_FILE_FACT_RECORDS) return;
		for (const key of this.fileFacts.keys()) {
			if (this.pinnedFiles.has(key)) continue;
			this.fileFacts.delete(key);
			if (this.fileFacts.size <= MAX_FILE_FACT_RECORDS) return;
		}
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
