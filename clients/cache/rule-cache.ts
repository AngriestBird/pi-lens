/**
 * Rule Cache for pi-lens
 *
 * Provides disk-based caching for parsed tree-sitter rules with
 * automatic invalidation based on rule file modification times.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.js";
import { readJsonCache } from "../json-cache-read.js";

// v4: cache skip_test_files + fix_action — v3 entries silently dropped them,
// and ruleHash (rule-file mtimes) never invalidates on a code-only fix.
export const CACHE_VERSION = "v4";

export interface QueryCacheEntry {
	version: string;
	timestamp: number;
	ruleHash: string;
	queries: Array<{
		id: string;
		name: string;
		severity: string;
		language: string;
		message: string;
		query: string;
		metavars: string[];
		post_filter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Flexible filter params
		post_filter_params?: Record<string, any>;
		defect_class?: string;
		inline_tier?: "blocking" | "warning" | "review";
		skip_test_files?: boolean;
		has_fix?: boolean;
		fix_action?: string;
		filePath?: string;
	}>;
}

export class RuleCache {
	private cacheFile: string;
	private cacheDir: string;
	private language: string;

	constructor(language: string, rootDir = process.cwd()) {
		this.language = language;
		this.cacheDir = path.join(getProjectDataDir(rootDir), "cache");
		this.cacheFile = path.join(
			this.cacheDir,
			`${language}-rules-${CACHE_VERSION}.json`,
		);
	}

	private ensureCacheDir(): void {
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
	}

	private computeRuleHash(ruleFiles: string[]): string {
		const hash = crypto.createHash("sha256");
		for (const file of ruleFiles.sort((a, b) => a.localeCompare(b))) {
			if (fs.existsSync(file)) {
				const stat = fs.statSync(file);
				hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
			}
		}
		return hash.digest("hex").slice(0, 16);
	}

	get(ruleFiles: string[]): QueryCacheEntry | null {
		try {
			this.ensureCacheDir();
			if (!fs.existsSync(this.cacheFile)) return null;

			const currentHash = this.computeRuleHash(ruleFiles);
			const cached = readJsonCache<QueryCacheEntry>(
				this.cacheFile,
				(parsed) => {
					const entry = parsed as QueryCacheEntry;
					if (
						entry.version !== CACHE_VERSION ||
						entry.ruleHash !== currentHash
					) {
						return undefined; // Cache invalid
					}
					return entry;
				},
			);
			return cached ?? null;
		} catch {
			return null;
		}
	}

	set(ruleFiles: string[], queries: QueryCacheEntry["queries"]): void {
		try {
			this.ensureCacheDir();
			const entry: QueryCacheEntry = {
				version: CACHE_VERSION,
				timestamp: Date.now(),
				ruleHash: this.computeRuleHash(ruleFiles),
				queries,
			};
			fs.writeFileSync(this.cacheFile, JSON.stringify(entry, null, 2));
			this.pruneStaleVersions();
		} catch {
			// Cache write failure is non-fatal
		}
	}

	// Orphaned `<language>-rules-v<N>.json` files from a prior CACHE_VERSION
	// (e.g. v3 entries left behind by the #448 v3→v4 bump) never got cleaned up
	// on their own — nothing ever read or removed them again once the version
	// bumped. Delete every sibling for this language that isn't the current file.
	private pruneStaleVersions(): void {
		const currentName = path.basename(this.cacheFile);
		const pattern = new RegExp(`^${this.language}-rules-v\\d+\\.json$`);
		let dirents: string[];
		try {
			dirents = fs.readdirSync(this.cacheDir);
		} catch {
			return;
		}
		for (const name of dirents) {
			if (name === currentName || !pattern.test(name)) continue;
			try {
				fs.unlinkSync(path.join(this.cacheDir, name));
			} catch {
				// Best-effort; ENOENT (already gone) or any other removal failure
				// shouldn't undo the write that already succeeded above.
			}
		}
	}

	clear(): void {
		try {
			if (fs.existsSync(this.cacheFile)) {
				fs.unlinkSync(this.cacheFile);
			}
		} catch {
			// Ignore
		}
	}
}
