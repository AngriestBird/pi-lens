import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { getProjectDataDir } from "./file-utils.js";
import { readJsonCache } from "./json-cache-read.js";
import { normalizeMapKey } from "./path-utils.js";
import type { ProjectLanguageProfile } from "./language-policy.js";
import {
	detectProjectConventions,
	type ProjectConventions,
} from "./project-conventions.js";
import type { RuleScanResult } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { StartupScanContext } from "./startup-scan.js";
import {
	deserializeWordIndex,
	serializeWordIndex,
	type SerializedWordIndex,
} from "./word-index.js";

// v2: added `wordIndex` (identifier inverted index + BM25, #162). Bumping the
// version invalidates pre-v2 snapshots so they rebuild with the new field.
export const PROJECT_SNAPSHOT_VERSION = 2;

export interface ProjectSnapshotFile {
	path: string;
	mtimeMs: number;
	size: number;
	hash?: string;
	language?: string;
	lineCount?: number;
	imports?: string[];
	symbolCount?: number;
	lastSeq: number;
}

export interface ProjectSnapshotSymbol {
	name: string;
	kind: string;
	filePath: string;
	startLine?: number;
	endLine?: number;
}

export interface ProjectSnapshot {
	version: typeof PROJECT_SNAPSHOT_VERSION;
	projectRoot: string;
	generatedAt: string;
	seq: number;
	files: Record<string, ProjectSnapshotFile>;
	symbols: Record<string, ProjectSnapshotSymbol[]>;
	reverseDeps: Record<string, string[]>;
	cachedExports: Array<[name: string, filePath: string]>;
	wordIndex?: SerializedWordIndex;
	projectRulesScan?: RuleScanResult;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
}

export function getProjectSnapshotPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json");
}

export function getProjectSnapshotMetaPath(cwd: string): string {
	return path.join(
		getProjectDataDir(cwd),
		"cache",
		"project-snapshot.meta.json",
	);
}

export function isProjectSnapshotFresh(
	snapshot: ProjectSnapshot | null | undefined,
	currentProjectSeq: number,
): snapshot is ProjectSnapshot {
	return (
		!!snapshot &&
		snapshot.version === PROJECT_SNAPSHOT_VERSION &&
		snapshot.seq === currentProjectSeq
	);
}

function parseSnapshot(value: unknown): ProjectSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const snapshot = value as Partial<ProjectSnapshot>;
	if (snapshot.version !== PROJECT_SNAPSHOT_VERSION) return null;
	if (typeof snapshot.projectRoot !== "string") return null;
	if (typeof snapshot.generatedAt !== "string") return null;
	if (typeof snapshot.seq !== "number") return null;
	if (!Array.isArray(snapshot.cachedExports)) return null;
	return {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: snapshot.projectRoot,
		generatedAt: snapshot.generatedAt,
		seq: snapshot.seq,
		files: snapshot.files ?? {},
		symbols: snapshot.symbols ?? {},
		reverseDeps: snapshot.reverseDeps ?? {},
		cachedExports: snapshot.cachedExports.filter(
			(entry): entry is [string, string] =>
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				typeof entry[1] === "string",
		),
		wordIndex: snapshot.wordIndex,
		projectRulesScan: snapshot.projectRulesScan,
		startupScan: snapshot.startupScan,
		languageProfile: snapshot.languageProfile,
		conventions: snapshot.conventions,
	};
}

export interface ProjectSnapshotMeta {
	timestamp: string;
	version: number;
	seq: number;
}

function parseSnapshotMeta(value: unknown): ProjectSnapshotMeta | null {
	if (!value || typeof value !== "object") return null;
	const meta = value as Partial<ProjectSnapshotMeta>;
	if (typeof meta.version !== "number") return null;
	if (typeof meta.seq !== "number") return null;
	return {
		timestamp: typeof meta.timestamp === "string" ? meta.timestamp : "",
		version: meta.version,
		seq: meta.seq,
	};
}

/**
 * Read the tiny meta sidecar (`project-snapshot.meta.json`) WITHOUT parsing
 * the (potentially 40-112MB) snapshot body. Written on every save; absent on
 * legacy installs — callers must treat a `null` return as "no opinion" and
 * fall through to parsing the body. #947.
 */
export function readProjectSnapshotMeta(cwd: string): ProjectSnapshotMeta | null {
	const meta = readJsonCache<ProjectSnapshotMeta>(
		getProjectSnapshotMetaPath(cwd),
		(parsed) => parseSnapshotMeta(parsed) ?? undefined,
	);
	return meta ?? null;
}

/**
 * Cheap staleness verdict from the meta sidecar alone. When this returns
 * true, the snapshot body CANNOT be fresh (isProjectSnapshotFresh would
 * reject it on the same two fields), so the expensive body parse can be
 * skipped entirely. #947.
 */
export function isProjectSnapshotMetaStale(
	meta: ProjectSnapshotMeta,
	currentProjectSeq: number,
): boolean {
	return (
		meta.version !== PROJECT_SNAPSHOT_VERSION || meta.seq !== currentProjectSeq
	);
}

/**
 * In-process parse cache for the snapshot body, keyed by file path and
 * validated by mtime. The body is large (40-112MB observed) and several
 * session-start/background consumers parse it seconds after we ourselves
 * wrote it — `saveRuntimeProjectSnapshot` alone re-parsed the file it had
 * just written 2-3x per session (~300-600ms of event-loop blocks). A hit
 * returns the already-parsed object; any external write changes the mtime
 * and forces a re-parse. #947.
 *
 * Deferred: gzipping the snapshot (as the review graph already does via its
 * worker-thread persist, `clients/review-graph/persist-worker.ts`) should
 * follow that same pattern — worker-offloaded stringify+gzip with
 * generation-gated promotion — rather than a sync gzip on the save path.
 */
interface SnapshotParseCacheEntry {
	mtimeMs: number;
	/**
	 * Size in bytes at cache time. FAT/exFAT round `mtime` to a 2s bucket, so
	 * two writes inside the same bucket can report an IDENTICAL `mtimeMs` even
	 * though the body changed — mtime alone would then serve a stale cached
	 * parse for a file that was, in fact, just rewritten. `size` is already
	 * computed for free at both cache-write sites (the `fs.statSync` call
	 * below, and the byte-length check in `saveProjectSnapshot`), so requiring
	 * it to also match is a free, defensive tiebreaker: a same-bucket rewrite
	 * that also happens to keep the exact same byte length still slips
	 * through, but that residual case is the same fail-open/self-healing
	 * posture as the rest of this cache (worst case: one stale read until the
	 * next external write changes the size or crosses an mtime bucket).
	 */
	size: number;
	snapshot: ProjectSnapshot | null;
}
const SNAPSHOT_PARSE_CACHE_MAX = 4;
// #957 review: the cache exists to avoid re-parsing NORMAL snapshots within a
// session. A 112MB-class body parses to hundreds of MB of heap — pinning that
// for process lifetime inverts the win, so oversized bodies are simply never
// cached (they re-parse per read, exactly the pre-#947 behavior).
const SNAPSHOT_PARSE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const snapshotParseCache = new Map<string, SnapshotParseCacheEntry>();

function cacheParsedSnapshot(
	snapshotPath: string,
	entry: SnapshotParseCacheEntry,
): void {
	// Refresh recency (Map preserves insertion order).
	snapshotParseCache.delete(snapshotPath);
	snapshotParseCache.set(snapshotPath, entry);
	while (snapshotParseCache.size > SNAPSHOT_PARSE_CACHE_MAX) {
		const oldest = snapshotParseCache.keys().next().value;
		if (oldest === undefined) break;
		snapshotParseCache.delete(oldest);
	}
}

/** Test hook: drop all cached parses (per-worker isolation). */
export function _resetProjectSnapshotParseCacheForTests(): void {
	snapshotParseCache.clear();
}

export function loadProjectSnapshot(cwd: string): ProjectSnapshot | null {
	const snapshotPath = getProjectSnapshotPath(cwd);
	let mtimeMs: number;
	let size: number;
	try {
		const stat = fs.statSync(snapshotPath);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch {
		// Missing snapshots are the normal cold-start case.
		snapshotParseCache.delete(snapshotPath);
		return null;
	}
	const cached = snapshotParseCache.get(snapshotPath);
	// Both mtime AND size must match (see the `size` field doc on
	// SnapshotParseCacheEntry for why: coarse FAT/exFAT mtime resolution can
	// otherwise alias a just-rewritten file onto a stale cache entry).
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached.snapshot;
	}
	const snapshot =
		readJsonCache<ProjectSnapshot>(
			snapshotPath,
			(parsed) => parseSnapshot(parsed) ?? undefined,
		) ?? null;
	if (size > 0 && size <= SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
		cacheParsedSnapshot(snapshotPath, { mtimeMs, size, snapshot });
	} else {
		snapshotParseCache.delete(snapshotPath);
	}
	return snapshot;
}

export function saveProjectSnapshot(
	cwd: string,
	snapshot: ProjectSnapshot,
): void {
	const snapshotPath = getProjectSnapshotPath(cwd);
	const metaPath = getProjectSnapshotMetaPath(cwd);
	fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
	// Compact serialization (no pretty-print): ~30% smaller at the observed
	// 40-112MB sizes, which directly shrinks both the write and every later
	// read+parse on session start. #947.
	const serialized = JSON.stringify(snapshot);

	// #958: meta is written FIRST, body SECOND — the reverse of the original
	// order. A crash/failure between the two writes can now only produce
	// "meta already claims the new seq, body hasn't caught up yet" (the meta
	// races ahead). The meta-first gate (isProjectSnapshotMetaStale) reads
	// that as *fresh* and falls through to parsing the body, whose own
	// embedded `seq` is still the old one, so `isProjectSnapshotFresh`
	// correctly rejects it as stale on the body's own merits — one wasted
	// parse, self-healing, no data lost. The OLD body-then-meta order could
	// instead leave an old-seq meta sitting over a freshly written body,
	// which the meta-first gate discards WITHOUT ever reading it — throwing
	// away a genuinely fresh snapshot. That direction is not recoverable
	// until the next save, so it's the one this reorder eliminates.
	//
	// Both writes go through the shared atomic tmp+rename helper so a
	// concurrent reader never observes a torn (partially written) file
	// either way. The meta write uses `bestEffort: false`: if the (tiny,
	// unlikely-to-fail) meta write itself fails, the body write below is
	// skipped entirely — the save is simply lost this round (fail-open,
	// caught by `saveRuntimeProjectSnapshot`'s own try/catch) rather than
	// silently leaving a stale meta in place while the body writer stampedes
	// ahead with a fresh body under it, which would reintroduce the exact
	// skew direction being fixed here.
	writeFileAtomic(
		metaPath,
		JSON.stringify({
			timestamp: snapshot.generatedAt,
			version: snapshot.version,
			seq: snapshot.seq,
		}),
		{ bestEffort: false },
	);
	try {
		writeFileAtomic(snapshotPath, serialized, { bestEffort: false });
	} catch (err) {
		// #957 review: callers mutate the loaded (= cached) object in place
		// before saving. If the body write fails (disk full, AV/OneDrive
		// lock), the cache would keep serving that never-persisted state
		// under the old mtime — drop the entry so the next load re-reads
		// what is actually on disk.
		snapshotParseCache.delete(snapshotPath);
		throw err;
	}
	// Prime the parse cache with the object we just wrote so the next
	// loadProjectSnapshot (e.g. saveRuntimeProjectSnapshot's merge read
	// seconds later) doesn't re-parse our own write. Best-effort: a failed
	// stat just means the next load re-parses. Oversized bodies are never
	// cached (see SNAPSHOT_PARSE_CACHE_MAX_BYTES).
	try {
		const size = Buffer.byteLength(serialized);
		if (size <= SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
			cacheParsedSnapshot(snapshotPath, {
				mtimeMs: fs.statSync(snapshotPath).mtimeMs,
				size,
				snapshot,
			});
		} else {
			snapshotParseCache.delete(snapshotPath);
		}
	} catch {
		snapshotParseCache.delete(snapshotPath);
	}
}

export function buildProjectSnapshotFromRuntime(args: {
	cwd: string;
	runtime: RuntimeCoordinator;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
}): ProjectSnapshot {
	return {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: normalizeMapKey(path.resolve(args.cwd)),
		generatedAt: new Date().toISOString(),
		seq: args.runtime.projectSeq,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [...args.runtime.cachedExports.entries()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		wordIndex: args.runtime.wordIndex
			? serializeWordIndex(args.runtime.wordIndex)
			: undefined,
		projectRulesScan: args.runtime.projectRulesScan,
		startupScan: args.startupScan,
		languageProfile: args.languageProfile,
		conventions: args.conventions,
	};
}

export function hydrateRuntimeFromProjectSnapshot(
	runtime: RuntimeCoordinator,
	snapshot: ProjectSnapshot,
): void {
	runtime.cachedExports.clear();
	for (const [name, filePath] of snapshot.cachedExports) {
		runtime.cachedExports.set(name, filePath);
	}
	if (snapshot.projectRulesScan) {
		runtime.projectRulesScan = snapshot.projectRulesScan;
	}
	runtime.wordIndex = deserializeWordIndex(snapshot.wordIndex);
}

export function saveRuntimeProjectSnapshot(args: {
	cwd: string;
	runtime: RuntimeCoordinator;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
	dbg?: (msg: string) => void;
}): void {
	try {
		if (typeof args.runtime.projectSeq !== "number") return;
		const existing = loadProjectSnapshot(args.cwd);
		let conventions = args.conventions ?? existing?.conventions;
		if (!conventions) {
			try {
				conventions = detectProjectConventions(args.cwd);
			} catch (err) {
				args.dbg?.(`project_snapshot: convention detection failed: ${err}`);
			}
		}
		const snapshot = buildProjectSnapshotFromRuntime({
			...args,
			startupScan: args.startupScan ?? existing?.startupScan,
			languageProfile: args.languageProfile ?? existing?.languageProfile,
			conventions,
		});
		if (existing) {
			snapshot.files = existing.files ?? {};
			snapshot.symbols = existing.symbols ?? {};
			snapshot.reverseDeps = existing.reverseDeps ?? {};
			// The word index is built by its own session task, which may not have
			// finished when another task triggers a save — keep the prior index
			// rather than clobbering it with undefined. #348: only carry it forward
			// when `existing` was built AT THIS SAME seq — otherwise a stale
			// snapshot's leftover index (already correctly rejected as stale by
			// isProjectSnapshotFresh on load, seq mismatch) would get silently
			// re-stamped with the CURRENT seq by this save, "laundering" a stale
			// index into looking fresh before the word-index task even runs.
			if (!snapshot.wordIndex && existing.wordIndex && existing.seq === snapshot.seq) {
				snapshot.wordIndex = existing.wordIndex;
			}
		}
		saveProjectSnapshot(args.cwd, snapshot);
		args.dbg?.(
			`project_snapshot: saved seq=${snapshot.seq} exports=${snapshot.cachedExports.length}`,
		);
	} catch (err) {
		args.dbg?.(`project_snapshot: save failed: ${err}`);
	}
}
