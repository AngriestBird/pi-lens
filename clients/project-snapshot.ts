import * as fs from "node:fs";
import * as path from "node:path";
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
	try {
		mtimeMs = fs.statSync(snapshotPath).mtimeMs;
	} catch {
		// Missing snapshots are the normal cold-start case.
		snapshotParseCache.delete(snapshotPath);
		return null;
	}
	const cached = snapshotParseCache.get(snapshotPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.snapshot;
	const snapshot =
		readJsonCache<ProjectSnapshot>(
			snapshotPath,
			(parsed) => parseSnapshot(parsed) ?? undefined,
		) ?? null;
	let fileBytes = 0;
	try {
		fileBytes = fs.statSync(snapshotPath).size;
	} catch {
		/* raced a delete — skip caching */
	}
	if (fileBytes > 0 && fileBytes <= SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
		cacheParsedSnapshot(snapshotPath, { mtimeMs, snapshot });
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
	fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
	// Compact serialization (no pretty-print): ~30% smaller at the observed
	// 40-112MB sizes, which directly shrinks both the write and every later
	// read+parse on session start. #947.
	const serialized = JSON.stringify(snapshot);
	try {
		fs.writeFileSync(snapshotPath, serialized);
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
		if (Buffer.byteLength(serialized) <= SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
			cacheParsedSnapshot(snapshotPath, {
				mtimeMs: fs.statSync(snapshotPath).mtimeMs,
				snapshot,
			});
		} else {
			snapshotParseCache.delete(snapshotPath);
		}
	} catch {
		snapshotParseCache.delete(snapshotPath);
	}
	fs.writeFileSync(
		getProjectSnapshotMetaPath(cwd),
		JSON.stringify({
			timestamp: snapshot.generatedAt,
			version: snapshot.version,
			seq: snapshot.seq,
		}),
	);
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
