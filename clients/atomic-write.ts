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
 * then `rename()`d over the target. `rename()` replaces the destination
 * atomically on both POSIX and Windows (libuv uses
 * `MOVEFILE_REPLACE_EXISTING`). Therefore:
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
 * process (e.g. `sweepStaleStageFiles` in `review-graph/builder.ts`).
 *
 * The `<seq>` group is optional so that staging files written by a *pre-#1205*
 * build still on disk (`.tmp-<pid>`) are also swept.
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
