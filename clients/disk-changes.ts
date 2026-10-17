/**
 * #4535: one publisher for disk changes pi-lens did not author.
 *
 * Five push detectors notice such a change (opaque bash recovery, the HEAD
 * look, the out-of-band look, the observed-mutation settled sweep, the LSP
 * drift heartbeat). Before this module each one hand-wired its own set of
 * consumers, so the review graph, the word index, the project snapshot and the
 * diagnostics cache only learned about a change if that particular detector
 * happened to know about them — after a HEAD move or an external edit they
 * served old bytes while LSP resynced, and `projectSeq` never moved, so
 * `isProjectSnapshotFresh` read the stale snapshot as fresh.
 *
 * A detector now calls {@link publishDiskChange} with what it saw. The
 * publisher:
 * 1. allocates the EXISTING project sequence through
 *    `RuntimeCoordinator.recordProjectMutations` (one locked append for the
 *    whole recorded population, `source: "external"`), never a second sequence
 *    space — five consumers already compare their state against `projectSeq`,
 *    and a parallel counter would make every snapshot read fresh;
 * 2. fans one {@link DiskChange} out to every registered subscriber, isolated
 *    one from another;
 * 3. returns the record and each subscriber's opaque answer, so an awaited
 *    caller (the out-of-band look's restart count) can order its own work.
 *
 * Invariants (audit §3.3):
 * - the detector commits its own per-root record BEFORE publishing (I1);
 * - the sequence is allocated BEFORE the fan-out, so one `seq` and one `at`
 *   describe the same event for every consumer (I2);
 * - the caller owns the await: the publisher awaits its subscribers, and the
 *   detector decides whether the hook waits for that under its own bound (I3);
 * - the publisher writes the sequence and the change log only. Authorship,
 *   turn state, the format queue and the dispatch delta stay agent-only: an
 *   incoming change never credits authorship (#4131) and moves no FileTime
 *   (#3865) (I4);
 * - a throwing subscriber is isolated and recorded once per consumer per root
 *   per session (I5).
 *
 * The registry is process-wide, like the per-root records the out-of-band look
 * keeps: a subscriber describes the disk, not a session, and two sessions on
 * one root share it. It is bounded by construction (one entry per registered
 * consumer id; publishing grows nothing).
 */
import type { ContentStamp } from "./content-stamp.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";
import type { ProjectChangeSource } from "./project-changes.js";

/** Which detector observed the change. */
export type DiskChangeOrigin =
	| "out-of-band"
	| "bash-recovery"
	| "head-move"
	| "settled-sweep"
	| "drift-heartbeat";

/**
 * The evidence the detector holds (`AGENTS.md` shape 10: a skip has a verdict
 * only with a stated reason, and "not reproduced" needs evidence):
 * - `observed` — the detector read the bytes (bash content diff, settled-sweep
 *   hash, drift fingerprint);
 * - `inferred` — the detector saw only an identity/size/mtime/HEAD change (an
 *   install stamp, a HEAD delta, a declaration stat walk). An `inferred` change
 *   may never be used to confirm a finding "not reproduced"; a marker that
 *   subscribes to both kinds confirms with its own content check.
 */
export type DiskChangeKind = "observed" | "inferred";

/** A path's typed change, in the detector's own spelling. */
export interface DiskPathChange {
	/** As the detector saw it: an LSP watched-files event is a URI. */
	filePath: string;
	type: "created" | "changed" | "deleted";
}

export interface DiskChange {
	/**
	 * The project sequence after the batch's allocation (0 when nothing was
	 * allocated: an unenumerable change, or a publisher called without a
	 * runtime). A subscriber treats 0 as "no seq evidence" and falls back to
	 * its own content check.
	 */
	seq: number;
	/** Each recorded path's fileSeq, keyed by the bump's normalized key. */
	fileSeqs: ReadonlyMap<string, number>;
	/** Canonical project root the change belongs to. */
	root: string;
	origin: DiskChangeOrigin;
	/** Every trigger that fed this publish (one per detector branch). */
	sources: readonly string[];
	kind: DiskChangeKind;
	/**
	 * The recorded population, normalized. `"unknown"` when the change cannot
	 * be enumerated (a dependency install, a cut delta): a subscriber then takes
	 * its conservative branch rather than reading the empty list as "nothing
	 * changed".
	 */
	paths: readonly string[] | "unknown";
	/** The typed subset, when the detector typed each path. */
	pathChanges?: readonly DiskPathChange[];
	/** Byte stamps for the paths the detector actually read (#4551). */
	after?: ReadonlyMap<string, ContentStamp>;
	/** One wall clock for the whole publish. */
	at: number;
	/** The live session generation when the publisher had one; 0 otherwise. */
	sessionScopeId: number;
}

export interface DiskChangeSubscriber {
	/** Stable consumer id; a second registration of one id replaces the first. */
	id: string;
	handler: (change: DiskChange) => unknown;
}

/**
 * The producer's structural view of the runtime: the bulk mutation seam plus
 * the session identity a session-scoped subscriber fences on. `RuntimeCoordinator`
 * satisfies it; a test passes a plain object.
 */
export interface DiskChangeRuntime {
	recordProjectMutations?(args: {
		paths: readonly string[];
		source: ProjectChangeSource;
		cwd?: string;
		onAppendError?: (err: unknown) => void;
	}): { projectSeq: number; fileSeqs: ReadonlyMap<string, number> };
	readonly sessionGeneration?: number;
}

export interface DiskChangeInput {
	root: string;
	origin: DiskChangeOrigin;
	/** Detector branch labels; defaults to the origin. */
	sources?: readonly string[];
	/** Defaults to `inferred`: a detector that only stat-compared says so. */
	kind?: DiskChangeKind;
	paths: readonly string[] | "unknown";
	pathChanges?: readonly DiskPathChange[];
	after?: ReadonlyMap<string, ContentStamp>;
	/** One clock for the publish; defaults to now. */
	at?: number;
}

export interface DiskChangePublishResult {
	change: DiskChange;
	/** Each subscriber's own answer, by consumer id. Opaque to the publisher. */
	results: ReadonlyMap<string, unknown>;
}

/**
 * Paths one publish allocates a sequence for. A longer population (a HEAD
 * move's delta, a settled sweep) records the first 64 and reports the rest as
 * unenumerable with one bounded record: the conservative direction for every
 * subscriber, never a false clean.
 */
export const DISK_CHANGE_MAX_RECORDED_PATHS = 64;

const REGISTRY_FAMILY = "disk-changes.subscribers";
const REGISTRY_VERSION = 1;

function subscribers(): Map<string, DiskChangeSubscriber> {
	return getProcessSingleton(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => new Map<string, DiskChangeSubscriber>(),
	);
}

/**
 * Register a consumer. Idempotent per id (a second module evaluation adopts
 * the first cell and replays the same registration instead of double-
 * delivering). Returns the unsubscriber.
 */
export function subscribeDiskChange(
	id: string,
	handler: (change: DiskChange) => unknown,
): () => void {
	subscribers().set(id, { id, handler });
	return () => {
		if (subscribers().get(id)?.handler === handler) subscribers().delete(id);
	};
}

/** The registered consumer ids, in registration order (census + tests). */
export function diskChangeSubscriberIds(): string[] {
	return [...subscribers().keys()];
}

function publishFailure(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Publish one disk change: allocate the existing sequence for the recorded
 * population, then fan out. Never throws for a subscriber's failure and never
 * throws for an append failure (`recordProjectMutations` routes that to
 * `onAppendError`); a caller that needs the failure passes the callback.
 */
export async function publishDiskChange(
	input: DiskChangeInput,
	runtime?: DiskChangeRuntime,
	onAppendError?: (err: unknown) => void,
): Promise<DiskChangePublishResult> {
	const at = input.at ?? Date.now();
	const root = normalizeMapKey(input.root);
	const normalized = input.paths === "unknown" ? [] : uniquePaths(input.paths);
	const truncated =
		input.paths !== "unknown" &&
		normalized.length > DISK_CHANGE_MAX_RECORDED_PATHS;
	const recorded = normalized.slice(0, DISK_CHANGE_MAX_RECORDED_PATHS);
	const { seq, fileSeqs } = allocateSequence(
		recorded,
		input,
		runtime,
		onAppendError,
	);
	if (truncated) {
		recordDegradationOnce({
			kind: "disk-change-paths-truncated",
			subject: root,
			reason: `one publish carried more than ${DISK_CHANGE_MAX_RECORDED_PATHS} paths; the first ${DISK_CHANGE_MAX_RECORDED_PATHS} got a sequence and the rest are reported as unenumerable`,
		});
	}
	const unknown = input.paths === "unknown" || truncated;
	const change: DiskChange = {
		seq,
		fileSeqs,
		root,
		origin: input.origin,
		sources: input.sources ?? [input.origin],
		kind: input.kind ?? "inferred",
		paths: unknown ? "unknown" : recorded,
		...(input.pathChanges ? { pathChanges: input.pathChanges } : {}),
		...(input.after ? { after: input.after } : {}),
		at,
		sessionScopeId: runtime?.sessionGeneration ?? 0,
	};
	const started = Date.now();
	const results = await fanOut(change);
	logLatency({
		type: "phase",
		phase: "disk_change_published",
		filePath: root,
		durationMs: Date.now() - started,
		result: `${input.origin}:${recorded.length}`,
		metadata: {
			origin: input.origin,
			sources: change.sources.join(","),
			kind: change.kind,
			recorded: recorded.length,
			unknown: unknown ? 1 : 0,
			truncated: truncated ? 1 : 0,
			seq,
			subscribers: [...subscribers().keys()].join(",").slice(0, 200),
		},
	});
	return { change, results };
}

/** The recorded population, de-duplicated in the map key's spelling. */
function uniquePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const filePath of paths) {
		const key = normalizeMapKey(filePath);
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(key);
	}
	return normalized;
}

/**
 * Step 1 (I2): the existing sequence, through the bulk mutation seam, before
 * any subscriber sees the record. A publisher with no runtime allocates
 * nothing and reports `seq: 0`, which a subscriber reads as "no seq evidence".
 */
function allocateSequence(
	recorded: readonly string[],
	input: DiskChangeInput,
	runtime: DiskChangeRuntime | undefined,
	onAppendError: ((err: unknown) => void) | undefined,
): { seq: number; fileSeqs: ReadonlyMap<string, number> } {
	if (recorded.length === 0) return { seq: 0, fileSeqs: new Map() };
	const allocated = runtime?.recordProjectMutations?.({
		paths: recorded,
		source: "external",
		cwd: input.root,
		...(onAppendError ? { onAppendError } : {}),
	});
	return {
		seq: allocated?.projectSeq ?? 0,
		fileSeqs: allocated?.fileSeqs ?? new Map(),
	};
}

/** Step 2 (I5): every registered consumer, isolated one from another. */
async function fanOut(change: DiskChange): Promise<Map<string, unknown>> {
	const results = new Map<string, unknown>();
	// A snapshot, not a live iteration: a subscriber that unsubscribes or
	// registers while this publish runs must not change who this one reaches.
	const registered = Array.from(subscribers().values());
	for (const subscriber of registered) {
		try {
			results.set(subscriber.id, await subscriber.handler(change));
		} catch (cause) {
			recordDegradationOnce({
				kind: "disk-change-subscriber-failed",
				subject: `${subscriber.id}:${change.root}`,
				reason: `subscriber threw: ${publishFailure(cause)}`,
			});
		}
	}
	return results;
}
