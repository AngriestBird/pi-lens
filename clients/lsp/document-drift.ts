/**
 * #1783 — disk-drift backstop for open LSP documents.
 *
 * An edit made outside the tracked write/edit path (a bash-tool bulk edit)
 * never produces a `didChange`, so the language server keeps answering from
 * the content it was last given. Nothing compared disk against that content,
 * so the stale view survived for as long as the server stayed up: proven live
 * on 2026-08-20, where `src/mcp/stdio.ts` published `diagnosticCount:2` for
 * 40 minutes while `tsc` on disk reported 0.
 *
 * This module records what content actually landed on a server and, on a
 * bounded cadence, compares disk against that record.
 *
 * ## The drift key pairs mtime with size (catalog shape 6)
 *
 * Neither half is sufficient on its own:
 *
 * - Size alone misses a same-length edit (a renamed identifier, a flipped
 *   comparison) — the exact shape a bulk sed produces.
 * - An mtime comparison alone misses an edit whose tool preserves the
 *   original timestamp (`cp -p`, an archive extract, a `utimes` restore).
 *
 * The mtime half compares against `syncedAt` — the wall clock at which the
 * content landed on the server — not against a stat taken at record time.
 * That keeps the recording path free of a stat: pi-lens always syncs AFTER
 * the write it is reacting to, so `mtimeMs > syncedAt` means "disk moved
 * after we last told the server anything".
 *
 * A stat divergence is a CANDIDATE, not a verdict. The sweep then reads the
 * file and compares the content fingerprint. A touched-but-unchanged file
 * (`touch`, a formatter that rewrote identical bytes) re-stamps its record
 * and sends nothing. That preserves the changed/unchanged distinction rather
 * than laundering both into one "drifted" verdict.
 *
 * Out of scope, stated plainly: an edit that changes content, keeps the
 * length identical, AND preserves mtime is invisible to `stat`. Detecting it
 * needs a read of every tracked document on every pass, which is the cost
 * this design exists to avoid. The disk-binding contentHash on the read path
 * (`diagnostic-binding.ts`) remains the check for that case.
 *
 * ## Cost and pacing
 *
 * One `stat` per tracked document per pass, at most {@link DRIFT_CHECK_BATCH}
 * documents per pass, at most one pass per {@link driftCheckIntervalMs}. A
 * read happens only for a document whose stat already diverged.
 *
 * Resyncs are capped at {@link DRIFT_RESYNC_BATCH} per pass and run serially,
 * so a 200-file bulk edit heals in paced rounds instead of firing 200
 * concurrent `didChange` writes at one single-threaded server — the #1714
 * sweep-burst shape. Each resync goes through the caller's normal touch path,
 * so it inherits the existing per-server notify-write budget and
 * backpressure demotion rather than bypassing them.
 */

import nodeFs from "node:fs";
import { normalizeMapKey } from "../path-utils.js";

/** Cheap content fingerprint. Same shape as the touch-debounce fingerprint. */
export function fingerprintDocumentContent(content: string): string {
	if (content.length <= 96) return `${content.length}:${content}`;
	return `${content.length}:${content.slice(0, 48)}:${content.slice(-48)}`;
}

/** What the server was last told, and when. */
export interface SyncedDocumentRecord {
	/** Byte length of the content that landed. The size half of the key. */
	readonly size: number;
	/** Fingerprint of that content. Confirms a stat candidate before a resync. */
	readonly fingerprint: string;
	/** Wall clock when it landed. The mtime half of the key compares to this. */
	readonly syncedAt: number;
}

export type DriftDisposition =
	/** Stat diverged and the content really changed; a resync was issued. */
	| "resynced"
	/** Stat diverged but the bytes are identical; the record was re-stamped. */
	| "unchanged"
	/** The file is gone or unreadable; the record was dropped. */
	| "vanished"
	/** No live client still holds the document; the record was dropped. */
	| "unheld"
	/** Drifted, but this pass's resync budget was already spent. */
	| "deferred";

export interface DriftSweepResult {
	/** Documents stat'd in this pass. */
	readonly checked: number;
	/** Documents whose (size, mtime) key diverged from the synced record. */
	readonly candidates: number;
	/** Documents actually resynchronized. */
	readonly resynced: number;
	/** Divergences that turned out to be identical bytes. */
	readonly unchanged: number;
	/** Divergences left for a later pass by the per-pass resync cap. */
	readonly deferred: number;
	/** Records dropped because the file no longer reads. */
	readonly vanished: number;
	/** Records dropped because no live client still holds the document. */
	readonly unheld: number;
	/** Tracked documents at the start of the pass. */
	readonly tracked: number;
}

const SKIPPED: DriftSweepResult = {
	checked: 0,
	candidates: 0,
	resynced: 0,
	unchanged: 0,
	deferred: 0,
	vanished: 0,
	unheld: 0,
	tracked: 0,
};

/** Documents stat'd per pass. Bounds the per-pass cost on a large workspace. */
export const DRIFT_CHECK_BATCH = 64;
/** Resyncs issued per pass. Paces the heal so a bulk edit cannot burst. */
export const DRIFT_RESYNC_BATCH = 4;
/** Tracked-document ceiling. A workspace sweep can open far more than this. */
export const DRIFT_TRACK_CAP = 512;

const DEFAULT_DRIFT_CHECK_INTERVAL_MS = 10_000;

/** Minimum gap between two drift passes. Env-tunable; 0 disables the sweep. */
export function driftCheckIntervalMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_DRIFT_CHECK_MS);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DRIFT_CHECK_INTERVAL_MS;
	return Math.floor(raw);
}

export interface DriftSweepDeps {
	/** Re-push disk content to the servers holding this document open. */
	resync(filePath: string, content: string, driftAgeMs: number): Promise<void>;
	/**
	 * Does a live language server still hold this document open? A record for a
	 * document nobody holds is dropped, never resynced — that is what keeps the
	 * backstop from spawning a server to correct a view that does not exist.
	 */
	holdsDocument?(filePath: string): boolean;
	/** Called once per confirmed drift, before the resync. Observability seam. */
	onDrift?(event: {
		filePath: string;
		driftAgeMs: number;
		disposition: DriftDisposition;
		syncedSize: number;
		diskSize: number;
	}): void;
	now?(): number;
	stat?(filePath: string): Promise<{ size: number; mtimeMs: number }>;
	read?(filePath: string): Promise<string>;
}

export class DocumentDriftTracker {
	/** Insertion-ordered; the sweep cursor walks it round-robin. */
	private readonly synced = new Map<string, SyncedDocumentRecord>();
	private lastSweepAt = 0;
	private cursor = 0;
	private inFlight: Promise<DriftSweepResult> | undefined;

	get size(): number {
		return this.synced.size;
	}

	peek(filePath: string): SyncedDocumentRecord | undefined {
		return this.synced.get(normalizeMapKey(filePath));
	}

	/**
	 * Record content that actually landed on a language server. Called from the
	 * same place the touch-debounce entry is written, so a write that timed out
	 * or rejected leaves no record and the document stays eligible for a resync.
	 */
	recordSynced(filePath: string, content: string, now = Date.now()): void {
		const key = normalizeMapKey(filePath);
		// Delete first so a re-record moves the entry to the END of the insertion
		// order. Without this, a hot file keeps an old cursor position and the
		// eviction below would drop it while stale entries survive.
		this.synced.delete(key);
		this.synced.set(key, {
			size: Buffer.byteLength(content, "utf8"),
			fingerprint: fingerprintDocumentContent(content),
			syncedAt: now,
		});
		while (this.synced.size > DRIFT_TRACK_CAP) {
			const oldest = this.synced.keys().next();
			if (oldest.done) break;
			this.synced.delete(oldest.value);
		}
	}

	forget(filePath: string): void {
		this.synced.delete(normalizeMapKey(filePath));
	}

	/** Drop every record. Used on shutdown/session reset, where the server's view dies with it. */
	clear(): void {
		this.synced.clear();
		this.cursor = 0;
		this.lastSweepAt = 0;
		this.inFlight = undefined;
	}

	/**
	 * Stat one batch of tracked documents and resync the ones whose disk state
	 * no longer matches what the server holds.
	 *
	 * Rate-limited and single-flight: callers fire this from hot paths without
	 * awaiting it, so an overlapping call must join the running pass rather than
	 * double the stat load.
	 */
	async sweep(
		deps: DriftSweepDeps,
		options: { force?: boolean } = {},
	): Promise<DriftSweepResult> {
		if (this.inFlight) return this.inFlight;
		const now = deps.now ?? Date.now;
		const intervalMs = driftCheckIntervalMs();
		if (!options.force) {
			if (intervalMs === 0) return SKIPPED;
			if (now() - this.lastSweepAt < intervalMs) return SKIPPED;
		}
		if (this.synced.size === 0) {
			this.lastSweepAt = now();
			return SKIPPED;
		}
		const run = this.runSweep(deps, now);
		this.inFlight = run;
		try {
			return await run;
		} finally {
			this.inFlight = undefined;
		}
	}

	private async runSweep(
		deps: DriftSweepDeps,
		now: () => number,
	): Promise<DriftSweepResult> {
		this.lastSweepAt = now();
		const stat = deps.stat ?? defaultStat;
		const read = deps.read ?? defaultRead;
		const keys = [...this.synced.keys()];
		const tracked = keys.length;
		if (this.cursor >= tracked) this.cursor = 0;
		const window: string[] = [];
		for (let i = 0; i < Math.min(DRIFT_CHECK_BATCH, tracked); i++) {
			window.push(keys[(this.cursor + i) % tracked] as string);
		}
		this.cursor = (this.cursor + window.length) % tracked;

		// Drop records nobody holds BEFORE spending a stat on them.
		let unheld = 0;
		const batch: string[] = [];
		for (const key of window) {
			const record = this.synced.get(key);
			if (!record) continue;
			if (deps.holdsDocument && !deps.holdsDocument(key)) {
				this.synced.delete(key);
				unheld += 1;
				deps.onDrift?.({
					filePath: key,
					driftAgeMs: Math.max(0, now() - record.syncedAt),
					disposition: "unheld",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			batch.push(key);
		}

		// The stats run concurrently: they are independent, and this pass is
		// already off the caller's critical path.
		const stats = await Promise.all(
			batch.map(async (key) => {
				try {
					return { key, stat: await stat(key) };
				} catch {
					return { key, stat: undefined };
				}
			}),
		);

		let candidates = 0;
		let vanished = 0;
		const drifted: Array<{ key: string; record: SyncedDocumentRecord }> = [];
		for (const entry of stats) {
			const record = this.synced.get(entry.key);
			if (!record) continue;
			if (!entry.stat) {
				this.synced.delete(entry.key);
				vanished += 1;
				deps.onDrift?.({
					filePath: entry.key,
					driftAgeMs: Math.max(0, now() - record.syncedAt),
					disposition: "vanished",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			// The paired key. Either half alone leaves a real edit undetected.
			const sizeMoved = entry.stat.size !== record.size;
			const mtimeMoved = entry.stat.mtimeMs > record.syncedAt;
			if (!sizeMoved && !mtimeMoved) continue;
			candidates += 1;
			drifted.push({ key: entry.key, record });
		}

		let resynced = 0;
		let unchanged = 0;
		let deferred = 0;
		for (const { key, record } of drifted) {
			const driftAgeMs = Math.max(0, now() - record.syncedAt);
			if (resynced >= DRIFT_RESYNC_BATCH) {
				// Paced, not dropped: the cursor already advanced past this file, but
				// a later pass wraps around to it. Recorded so a backlog is visible.
				deferred += 1;
				deps.onDrift?.({
					filePath: key,
					driftAgeMs,
					disposition: "deferred",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			let content: string;
			try {
				content = await read(key);
			} catch {
				this.synced.delete(key);
				vanished += 1;
				continue;
			}
			if (fingerprintDocumentContent(content) === record.fingerprint) {
				// Touched, not changed. Re-stamp so the next pass stops flagging it,
				// and send nothing: the server's view is already correct.
				unchanged += 1;
				this.recordSynced(key, content, now());
				deps.onDrift?.({
					filePath: key,
					driftAgeMs,
					disposition: "unchanged",
					syncedSize: record.size,
					diskSize: Buffer.byteLength(content, "utf8"),
				});
				continue;
			}
			deps.onDrift?.({
				filePath: key,
				driftAgeMs,
				disposition: "resynced",
				syncedSize: record.size,
				diskSize: Buffer.byteLength(content, "utf8"),
			});
			// Serial on purpose. See the pacing note in this module's header.
			try {
				await deps.resync(key, content, driftAgeMs);
			} catch {
				// A failed resync leaves the OLD record in place, so the next pass
				// retries this file instead of recording a heal that never happened.
				continue;
			}
			resynced += 1;
			this.recordSynced(key, content, now());
		}

		return {
			checked: batch.length,
			candidates,
			resynced,
			unchanged,
			deferred,
			vanished,
			unheld,
			tracked,
		};
	}
}

async function defaultStat(
	filePath: string,
): Promise<{ size: number; mtimeMs: number }> {
	const st = await nodeFs.promises.stat(filePath);
	return { size: st.size, mtimeMs: st.mtimeMs };
}

async function defaultRead(filePath: string): Promise<string> {
	return nodeFs.promises.readFile(filePath, "utf-8");
}
