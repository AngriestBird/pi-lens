/**
 * Shared atomic tmp+rename file writer (closes #762).
 *
 * The `${target}.tmp-…` + `renameSync` shape was independently hand-rolled in
 * five places (`instance-registry.ts`, `session-state-store.ts`,
 * `recent-touches.ts`, `review-graph/builder.ts`, `diagnostic-dispositions.ts`)
 * as each one picked up the need for a reader to never observe a
 * partially-written file. Five independent copies of the same shape invite
 * drift (e.g. forgetting the tmp-file cleanup on the failure path) — this
 * module is the single implementation the rest re-use.
 *
 * ## What this guarantees (#1205)
 *
 * Data is written in full to a staging file that no other writer can name,
 * then `rename()`d over the target. On POSIX, `rename()` replaces the
 * destination atomically by construction. On Windows, libuv uses
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which is atomic in practice
 * on a same-volume NTFS replace but — unlike POSIX `rename()` — is not a
 * formally guaranteed atomic primitive (`ReplaceFile` /
 * `SetFileInformationByHandle` are the stronger APIs). Therefore, modulo that
 * caveat:
 *
 *   - **Crash-safe replacement.** A crash mid-write leaves the target holding
 *     its previous complete contents plus an orphan staging file; it never
 *     leaves the target half-written.
 *   - **Tear-free publication.** Any reader — same process or not — observes
 *     either the fully-old or the fully-new file at the target path. Because
 *     the staging name is unique *per call* (pid + a monotonic per-process
 *     counter), this now holds for concurrent writes from the same process
 *     too. Before #1205 the staging name was only `.tmp-${pid}`, so two
 *     in-flight same-process writes to one target shared a staging inode; the
 *     first `rename` published it while the second writer was still writing
 *     into it, publishing a torn hybrid file.
 *
 * ## What this explicitly does NOT provide
 *
 *   - **No read-modify-write isolation.** Concurrent read → mutate → write
 *     cycles still lose updates: each writer publishes the state it computed
 *     from the snapshot it read, and last-rename-wins silently discards the
 *     other's mutation. Callers needing this must serialize themselves (see
 *     `lspChildRemovalTail` in `instance-registry.ts`).
 *   - **No ordering.** Nothing sequences concurrent writers, within or across
 *     processes. The winner is whichever `rename` lands last, which is not
 *     necessarily the write that started or finished last.
 *   - **No mutual exclusion.** This is not a lock. Overlapping writes are
 *     permitted and expected; only *torn* output is prevented.
 *   - **No fsync/durability guarantee.** Neither the staging file nor the
 *     parent directory is fsync'd, so a power loss (as opposed to a process
 *     crash) may lose the rename.
 *   - **No orphan reaping.** A process killed between the staging write and
 *     the rename leaves an orphan staging file that nothing in this module
 *     collects; that lifecycle gap is tracked in #1228, not solved here.
 *   - **Windows-specific loss under `bestEffort: true`.** `MoveFileEx` with
 *     `MOVEFILE_REPLACE_EXISTING` fails if a reader holds the destination
 *     open without `FILE_SHARE_DELETE`. On Windows this silently drops the
 *     write (swallowed like any other `bestEffort: true` failure); the
 *     identical code path succeeds on POSIX, where `rename()` does not care
 *     whether a reader has the destination open.
 *
 * Per-write-site error policy varies and is NOT a detail this helper should
 * paper over:
 *
 *   - `bestEffort: true` (the default, and the majority of today's sites): a
 *     write or rename failure just means this update is lost — swallow it,
 *     after a best-effort tmp-file cleanup. Appropriate for observability
 *     substrate (instance registry, recent-touches, review-graph cache,
 *     session widget state) where a dropped write is, at worst, a stale/
 *     missing sample.
 *   - `bestEffort: false`: rethrow the failure (after the same best-effort tmp
 *     cleanup). This is `clients/diagnostic-dispositions.ts`'s policy (#757):
 *     unlike the writers above, a disposition mark is functionally
 *     load-bearing — a silently lost mark is a correctness bug, not a dropped
 *     observability sample — so callers must see the failure rather than have
 *     it swallowed. See the #757 CHANGELOG entry for the full reasoning.
 */

import * as fs from "node:fs";

export interface WriteFileAtomicOptions {
	/**
	 * `true` (default): swallow write/rename failures after best-effort tmp
	 * cleanup — the update is simply lost. `false`: rethrow the failure after
	 * the same best-effort cleanup (the #757 disposition-store policy).
	 */
	bestEffort?: boolean;
}

/**
 * Monotonic per-process counter that makes each staging path unique per CALL,
 * not merely per process (#1205).
 *
 * A counter is used rather than `randomBytes`: it is allocation-free and
 * synchronous on what are hot per-turn/per-touch write paths, and it is
 * *exactly* as unique as needed — collisions only matter between two writes
 * live at the same instant in the same process, and a monotonic counter makes
 * those impossible by construction rather than merely improbable. `process.pid`
 * continues to supply cross-process distinctness.
 *
 * Main-thread-only. Worker threads get a fresh module instance (so a fresh
 * `_stageSeq` starting at 0) but share `process.pid` with the main thread and
 * each other, so two threads writing the same target could each mint
 * `${target}.tmp-<samepid>-0` — reintroducing the same-name collision this
 * counter exists to prevent. Not reachable today: neither `Worker` site
 * (`clients/review-graph/persist-worker.ts`,
 * `clients/project-snapshot-persist-worker.ts`) imports this module, both use
 * `gzip-stage-write.ts`'s own hand-rolled staging name instead. Any future
 * worker-side caller of `writeFileAtomic` must add `threadId` to the staging
 * name (and extend {@link STAGE_TMP_PATTERN} with a third optional group, in
 * lockstep with its tests) before it is safe.
 */
let _stageSeq = 0;

/**
 * Staging path for one write call: `${targetPath}.tmp-<pid>-<seq>`.
 *
 * Exported so that sweepers of orphaned staging files stay in lockstep with
 * the naming scheme instead of re-deriving it (see {@link STAGE_TMP_PATTERN}).
 */
export function stagePathFor(targetPath: string): string {
	return `${targetPath}.tmp-${process.pid}-${_stageSeq++}`;
}

/**
 * Matches the trailing staging-file marker produced by {@link stagePathFor},
 * for sweepers that garbage-collect staging files orphaned by a crashed
 * process (tracked as a lifecycle gap in #1228 — this module does not reap
 * its own orphans).
 *
 * The `<seq>` group is optional so that staging files written by a *pre-#1205*
 * build still on disk (`.tmp-<pid>`) are also swept.
 *
 * CAUTION for any sweeper adopting this pattern: it matches staging files by
 * *shape*, not by writer identity, so it will also match this process's own
 * still-being-written staging files unless the sweeper separately excludes
 * them by `process.pid`. `review-graph/builder.ts`'s `sweepStaleStageFiles`
 * cannot be pointed at this pattern as-is — its own-file guard is
 * `.stage-${process.pid}-`, which never appears in a `.tmp-<pid>-<seq>` name,
 * so widening its match to `STAGE_TMP_PATTERN` without also adding a
 * `.tmp-${process.pid}-` (or equivalent pid) exclusion would delete its own
 * in-flight `writeFileAtomic` staging files mid-write.
 *
 * The optional `<seq>` group also widens what matches versus the pre-#1205
 * pattern: e.g. `backup.tmp-2023-11` and `x.tmp-1-2` now match, while
 * `x.tmp-1-2-3`, `data.tmp-`, `x.tmp--1`, and `foo.TMP-42` still do not.
 * Anchoring is correct for both consumer styles in this repo today (matching
 * against a full path or a bare basename), but this is confined to pi-lens's
 * own cache directories — a consumer sweeping a directory it does not fully
 * control should not assume every match is one of this module's staging
 * files.
 */
export const STAGE_TMP_PATTERN = /\.tmp-\d+(?:-\d+)?$/;

/**
 * Synchronous atomic write of text or binary data to a per-call staging file,
 * then `fs.renameSync` over `targetPath`. On any failure (from either step),
 * attempts a best-effort `fs.rmSync(tmp, { force: true })` cleanup, then
 * either swallows (default) or rethrows per `options.bestEffort`.
 *
 * Does not create the parent directory — callers that need one must
 * `mkdirSync` before calling this (matches every existing call site, which
 * already does its own mkdir as a separate step).
 */
export function writeFileAtomic(
	targetPath: string,
	data: string | Uint8Array,
	options?: WriteFileAtomicOptions,
): void {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = stagePathFor(targetPath);
	try {
		fs.writeFileSync(tmpPath, data, typeof data === "string" ? "utf-8" : undefined);
		fs.renameSync(tmpPath, targetPath);
	} catch (err) {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}

/**
 * Async counterpart of {@link writeFileAtomic}, built on `fs.promises` instead
 * of the sync `fs` API — for call sites that must not block the event loop
 * (e.g. writes on a hot per-turn/per-touch path). Same per-call tmp-naming,
 * cleanup, and `bestEffort` semantics.
 */
export async function writeFileAtomicAsync(
	targetPath: string,
	data: string | Uint8Array,
	options?: WriteFileAtomicOptions,
): Promise<void> {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = stagePathFor(targetPath);
	try {
		await fs.promises.writeFile(
			tmpPath,
			data,
			typeof data === "string" ? "utf-8" : undefined,
		);
		await fs.promises.rename(tmpPath, targetPath);
	} catch (err) {
		try {
			await fs.promises.rm(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}
