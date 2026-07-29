/**
 * Tree-sitter Tree Cache
 *
 * Caches parsed ASTs so a file written once is parsed once and reused by every
 * subsystem that inspects it in the same process (#675).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { normalizeFilePath } from "./path-utils.js";

const TREE_RETIREMENT_GRACE_MICROTASKS = 4;

export interface CachedTree {
	tree: any; // Tree-sitter Tree instance
	contentHash: string;
	languageId: string;
	fileSize: number;
	lineCount: number;
	lastModified: number;
}

export interface TreeCacheCounters {
	lookups: number;
	hits: number;
	coldMisses: number;
	capacityMisses: number;
	contentChangedMisses: number;
	mtimeMisses: number;
	statFailedMisses: number;
	sets: number;
	replacements: number;
	evictions: number;
	clears: number;
	ghostHistoryDrops: number;
}

export const TREE_CACHE_COUNTER_KEYS = [
	"lookups",
	"hits",
	"coldMisses",
	"capacityMisses",
	"contentChangedMisses",
	"mtimeMisses",
	"statFailedMisses",
	"sets",
	"replacements",
	"evictions",
	"clears",
	"ghostHistoryDrops",
] as const satisfies readonly (keyof TreeCacheCounters)[];

export function createTreeCacheCounters(): TreeCacheCounters {
	return Object.fromEntries(
		TREE_CACHE_COUNTER_KEYS.map((key) => [key, 0]),
	) as unknown as TreeCacheCounters;
}

export interface TreeCacheStats extends TreeCacheCounters {
	size: number;
	maxSize: number;
	totalLines: number;
	totalBytes: number;
	misses: number;
}

export type TreeCacheCounterObserver = (
	key: keyof TreeCacheCounters,
	amount: number,
) => void;

export class TreeCache {
	private cache = new Map<string, CachedTree>();
	private recentlyEvicted = new Map<string, string>();
	private maxSize: number;
	private evictionHistoryMax: number;
	private debug: (msg: string) => void;
	private counters = createTreeCacheCounters();
	private counterObserver: TreeCacheCounterObserver | undefined;
	private treeErrorObserver: ((error: unknown) => void) | undefined;

	constructor(
		maxSize = 50,
		debug = false,
		evictionHistoryMax = 4096,
		counterObserver?: TreeCacheCounterObserver,
		treeErrorObserver?: (error: unknown) => void,
	) {
		this.maxSize = maxSize;
		this.evictionHistoryMax = Math.max(1, Math.floor(evictionHistoryMax));
		this.counterObserver = counterObserver;
		this.treeErrorObserver = treeErrorObserver;
		this.debug = debug
			? (msg: string) => console.error(`[tree-cache] ${msg}`)
			: () => {};
	}

	private recordCounter(key: keyof TreeCacheCounters, amount = 1): void {
		this.counters[key] += amount;
		this.counterObserver?.(key, amount);
	}

	/**
	 * Free a tree-sitter Tree's WASM-heap allocation.
	 *
	 * web-tree-sitter Trees live in the WASM heap; JS GC reclaims only the wrapper,
	 * so the underlying memory leaks unless `tree.delete()` is called explicitly
	 * (no FinalizationRegistry auto-free in 0.25). Guarded — a tree may already be
	 * deleted, or `delete()` may throw on a corrupt/aborted runtime. Retirement is
	 * deferred so direct parse callers resume before deletion; consumers still
	 * traverse without another await, or use the cache-safe callback API (#417).
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter Tree
	private freeTree(tree: any): void {
		try {
			if (tree && typeof tree.delete === "function") tree.delete();
		} catch (error) {
			this.treeErrorObserver?.(error);
		}
	}

	private retireTree(tree: any): void {
		let remaining = TREE_RETIREMENT_GRACE_MICROTASKS;
		const retire = (): void => {
			if (remaining-- > 0) {
				queueMicrotask(retire);
				return;
			}
			this.freeTree(tree);
		};
		queueMicrotask(retire);
	}

	/** Remove a cache entry and retire its WASM tree after current consumers run. */
	private removeEntry(key: string): void {
		const cached = this.cache.get(key);
		if (cached) this.retireTree(cached.tree);
		this.cache.delete(key);
	}

	private rememberEviction(key: string, cached: CachedTree): void {
		this.recentlyEvicted.delete(key);
		if (this.recentlyEvicted.size >= this.evictionHistoryMax) {
			const oldestKey = this.recentlyEvicted.keys().next().value;
			if (oldestKey !== undefined) {
				this.recentlyEvicted.delete(oldestKey);
				this.recordCounter("ghostHistoryDrops");
			}
		}
		this.recentlyEvicted.set(key, cached.contentHash);
	}

	/**
	 * Generate hash for file content
	 */
	private hashContent(content: string): string {
		return crypto
			.createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);
	}

	/**
	 * Get cache key for a file
	 */
	private getCacheKey(filePath: string, languageId: string): string {
		return `${languageId}:${normalizeFilePath(filePath)}`;
	}

	/**
	 * Check if tree is cached and valid
	 */
	get(filePath: string, content: string, languageId: string): any | null {
		this.recordCounter("lookups");
		const key = this.getCacheKey(filePath, languageId);
		const cached = this.cache.get(key);

		if (!cached) {
			const evictedHash = this.recentlyEvicted.get(key);
			if (
				evictedHash !== undefined &&
				evictedHash === this.hashContent(content)
			) {
				this.recordCounter("capacityMisses");
			} else {
				this.recordCounter("coldMisses");
			}
			this.debug(`Cache miss: ${filePath}`);
			return null;
		}

		// (No language-mismatch check needed: the cache key is prefixed with
		// languageId, so a key hit already implies the language matches.)

		// Check content hash
		const contentHash = this.hashContent(content);
		if (cached.contentHash !== contentHash) {
			this.recordCounter("contentChangedMisses");
			this.debug(
				`Content changed: ${filePath} (${cached.lineCount} → ${content.split("\n").length} lines)`,
			);
			// Keep old tree for potential incremental update, but mark as stale
			return null;
		}

		// Check if file was modified on disk (mtime changed)
		try {
			const stats = fs.statSync(filePath);
			if (stats.mtimeMs !== cached.lastModified) {
				this.recordCounter("mtimeMisses");
				this.debug(`File modified on disk: ${filePath}`);
				this.removeEntry(key);
				return null;
			}
		} catch {
			// File might be deleted, invalidate cache
			this.recordCounter("statFailedMisses");
			this.removeEntry(key);
			return null;
		}

		this.recordCounter("hits");
		this.debug(`Cache hit: ${filePath} (${cached.lineCount} lines)`);
		return cached.tree;
	}

	/**
	 * Store parsed tree in cache
	 */
	set(filePath: string, content: string, languageId: string, tree: any): void {
		this.recordCounter("sets");
		const key = this.getCacheKey(filePath, languageId);
		const contentHash = this.hashContent(content);
		this.recentlyEvicted.delete(key);

		// Free the tree we're about to replace at this key (re-parse of the same
		// file) so it doesn't leak its WASM heap.
		if (this.cache.has(key)) {
			this.recordCounter("replacements");
			this.removeEntry(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict + free the oldest entry when the cache is full.
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				const evicted = this.cache.get(firstKey);
				if (evicted) this.rememberEviction(firstKey, evicted);
				this.recordCounter("evictions");
				this.removeEntry(firstKey);
				this.debug(`Evicted: ${firstKey}`);
			}
		}

		let mtime = 0;
		try {
			mtime = fs.statSync(filePath).mtimeMs;
		} catch {
			// File deleted between parse and cache — cache with mtime=0;
			// next get() will miss on mtime check and re-parse
		}

		this.cache.set(key, {
			tree,
			contentHash,
			languageId,
			fileSize: Buffer.byteLength(content, "utf8"),
			lineCount: content.split("\n").length,
			lastModified: mtime,
		});

		this.debug(`Cached: ${filePath} (${content.split("\n").length} lines)`);
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		this.recordCounter("clears");
		for (const entry of this.cache.values()) {
			this.retireTree(entry.tree);
		}
		this.cache.clear();
		this.recentlyEvicted.clear();
		this.debug("Cache cleared");
	}

	/**
	 * Get cache statistics
	 */
	getStats(): TreeCacheStats {
		let totalLines = 0;
		let totalBytes = 0;
		for (const entry of this.cache.values()) {
			totalLines += entry.lineCount;
			totalBytes += entry.fileSize;
		}
		return {
			...this.counters,
			size: this.cache.size,
			maxSize: this.maxSize,
			totalLines,
			totalBytes,
			misses: this.counters.lookups - this.counters.hits,
		};
	}
}
