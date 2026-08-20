import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
	filePath: LATENCY_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** Process that wrote the entry; used to isolate current-session telemetry. */
	pid?: number;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

/** Bound on the `recentPhases` ring below — keeps the attribution record small. */
export const RECENT_PHASE_CAP = 5;

/**
 * Most recent non-`loop_block` phases seen by `logLatency`, newest first, for
 * cheap block attribution (#1122 / #1123 item 1, widened #1723): the
 * event-loop-block probe fires at turn_end and cannot see *what* stalled the
 * loop, so it stamps the phases that ran as a starting point for root-causing
 * a genuine block. A single `lastPhase` pointer names only the phase that
 * finished right before the block — useless when the CPU hog itself never got
 * to log a completion (it was busy blocking the loop). Keeping a short,
 * bounded ring instead gives the block's neighborhood, not just one frame of
 * it, while staying O(1) per call and fixed-size in memory. Tracked before the
 * test-mode guard so it is deterministic and unit-testable.
 */
let recentPhases: Array<{ phase: string; ts: string }> = [];

/**
 * Phases excluded from `lastPhase` attribution alongside `loop_block`.
 * #1412 L3: `lsp_typescript_project_identity` is the classic-TS first-open
 * project-identity probe (tsserver-sync.ts) — a detached, best-effort
 * telemetry sample fired on every first didOpen, not genuine work. Letting it
 * win `lastPhase` would overwrite the real stall attribution for a
 * loop_block that happens to land right after a first open.
 * #1432 review: `advisory_provenance_decision`,
 * `authoritative_content_attachment_decision`, and
 * `agent_end_deferred_mutation_drain` are the same shape — zero-duration
 * decision telemetry, not genuine work — so they get the same exclusion.
 * `agent_end_deferred_mutation_requeue` (S2d gap 4's per-requeue record) and
 * `session_end_bus_rollup` (S2d gap 5's session-end rollup) are new
 * zero-duration siblings of the same shape, added alongside them.
 *
 * `lsp_aux_wait_outcome` (#1458) is DIFFERENT from every entry above: its
 * `durationMs` is a REAL bounded wait, not zero-duration decision telemetry.
 * WHICH wait depends on the row's `waitShape` (#1533), so read that field before
 * comparing two rows: `"aux_grace"` measures only the post-primary auxiliary
 * grace (up to a few seconds), while `"aggregate"` — the `clientScope: "all"`
 * producer, which arms no grace of its own — measures the whole diagnostics wait
 * from before the primaries settled. The `"aggregate"` number is therefore
 * systematically larger for the same auxiliary; it is not a regression. It is
 * still
 * excluded because it is a WAIT-OUTCOME RECORD written after the aux wait
 * already completed, not the stall itself — that wait ran inside the
 * `lsp_touch_file`/diagnostics phase surrounding it, so letting this summary
 * row win `lastPhase` would misattribute a `loop_block` to the record instead
 * of to whatever phase is actually stalled when the block fires.
 * #1453: `tool_set_mutation` records an active-tool-set rewrite (zero-duration
 * bookkeeping, and it fires during session_start where a real stall must stay
 * attributed to the work around it), so it is excluded for the same reason.
 * #1467: `availability_decision` records a tool-probe verdict. Its `durationMs`
 * is the child's own probe time (often zero for a fast path or a cached
 * decision) and the record is bookkeeping ABOUT a probe, not host work — a
 * loop_block landing next to one must stay attributed to whatever really
 * stalled the loop, which is frequently the very thing that expired the probe.
 *
 * #1461 slice 1: `finding_dead_path_drop` is the same shape — the record a
 * delivery seam writes when it drops findings whose cited path no longer
 * exists. #1622 adds `finding_stale_line_demote`, its sibling for findings
 * whose cited file was edited after the scan.
 *
 * #1459: the three scanner-coverage records are summary rows written from inside
 * `lsp_touch_file`, and two of them carry ANOTHER write's age as `durationMs`
 * (`lsp_notify_resync_deferred`, `lsp_notify_write_late_landed`) rather than
 * their own work. `lsp_scanner_coverage_gap` reports the touch's elapsed time for
 * joinability. Letting any of them win `lastPhase` would attribute a `loop_block`
 * to the record instead of to the touch that is actually stalled.
 */
const LAST_PHASE_EXCLUDED = new Set([
	"loop_block",
	"lsp_typescript_project_identity",
	"advisory_provenance_decision",
	"authoritative_content_attachment_decision",
	"agent_end_deferred_mutation_drain",
	"agent_end_deferred_mutation_requeue",
	"session_end_bus_rollup",
	"lsp_aux_wait_outcome",
	"tool_set_mutation",
	"availability_decision",
	"finding_dead_path_drop",
	"finding_stale_line_demote",
	"lsp_scanner_coverage_gap",
	"lsp_notify_resync_deferred",
	"lsp_notify_write_late_landed",
]);

/**
 * The last non-`loop_block` phase logged, or undefined if none yet. Carries its
 * own `ts` so a consumer can gauge staleness: it is intentionally NOT cleared at
 * turn/window boundaries, so on a turn that logged no phase of its own it may
 * point at a prior turn's phase — compare `ts` against the block time before
 * trusting it as the cause (it is a breadcrumb, not proof).
 */
export function getLastLoggedPhase(): { phase: string; ts: string } | undefined {
	return recentPhases[0];
}

/**
 * The last `limit` non-`loop_block` phases logged, newest first (#1723).
 * Bounded to `RECENT_PHASE_CAP` regardless of `limit` — a caller cannot
 * request an unbounded ring. Same staleness caveat as `getLastLoggedPhase`:
 * these are breadcrumbs from whatever ran most recently, not proof of cause.
 */
export function getRecentLoggedPhases(
	limit = RECENT_PHASE_CAP,
): Array<{ phase: string; ts: string }> {
	return recentPhases.slice(0, Math.min(limit, RECENT_PHASE_CAP));
}

/**
 * Test-only: the ring's actual storage length, bypassing the read-side
 * `Math.min` clamp in `getRecentLoggedPhases` entirely. Needed because that
 * clamp and the write-side `.slice(0, RECENT_PHASE_CAP)` in `logLatency` are
 * a compensating pair — as long as ONE of them is intact, the other's
 * deletion is invisible to any test that only observes
 * `getRecentLoggedPhases()` output length. This pins the write-side guard
 * specifically: if its `.slice` is deleted, storage grows past the cap and
 * this returns the unclamped size regardless of what the read side does.
 */
export function _recentPhasesStorageLengthForTest(): number {
	return recentPhases.length;
}

/**
 * Test-only: seed the ring directly, bypassing the write-side cap in
 * `logLatency`. Lets a test put the ring in a state the normal write path can
 * never produce (more than `RECENT_PHASE_CAP` entries), so the read-side
 * clamp in `getRecentLoggedPhases` can be pinned independently of the
 * write-side guard (see `_recentPhasesStorageLengthForTest` above for why
 * that independence matters).
 */
export function _setRecentPhasesForTest(entries: Array<{ phase: string; ts: string }>): void {
	recentPhases = entries;
}

/** A phase's start marker, and the identity key its own `phaseFinished` call needs. */
export interface PhaseToken {
	phase: string;
	startedAt: string;
}

interface ClosedBracket {
	phase: string;
	startedAt: string;
	closedAt: string;
}

/** Bound on the closed-bracket ring below — same size discipline as `recentPhases`. */
export const CLOSED_BRACKET_CAP = RECENT_PHASE_CAP;

/**
 * Phases currently executing, keyed by their own start token (#1723 review
 * round: this replaces an earlier single-slot design that broke two ways.
 * `dispatchForFile` runs its runner groups in PARALLEL (`Promise.all`,
 * dispatcher.ts), so overlap is the NORMAL case, not an edge case:
 *   F1 — a single slot holds only the LAST starter. A cheap idle runner
 *        starting after a CPU hog wins the slot outright; a block gets
 *        attributed to the innocent idle runner while the hog stays
 *        anonymous.
 *   F2 — the inverse: a quick sibling that starts SECOND but FINISHES FIRST
 *        clears the slot the moment its own `finally` runs, wiping out the
 *        still-running long phase's attribution — the identity-token check
 *        only guarded the OTHER stale-clear direction (an EARLIER phase's
 *        late finish clobbering a LATER phase), not this one.
 * A `Map` keyed by the token itself (not by phase name — two calls can share
 * a name) fixes both: every bracket owns its own entry regardless of what
 * else is live, and `phaseFinished` only ever removes ITS OWN entry. `Map`
 * iteration order is insertion order, so the oldest surviving entry — read by
 * `getCurrentPhase` — is the longest-running phase still open: the one most
 * likely to own a long block.
 */
const liveBrackets = new Map<PhaseToken, true>();

/**
 * Recently CLOSED brackets, newest first, bounded to `CLOSED_BRACKET_CAP`
 * (#1723 review round, F3 — the decisive finding). `phaseFinished` runs
 * inside a `finally`, which resumes as a MICROTASK, while the host schedules
 * `turn_end` as a MACROTASK — and microtasks always fully drain before the
 * next macrotask runs. For the motivating SYNCHRONOUS block, this means the
 * offending phase has ALREADY closed (its `finally` already ran) by the time
 * `turn_end` gets to sample: `liveBrackets` alone reads EMPTY for exactly the
 * case this feature exists to catch. Keeping a short history of recently
 * closed brackets lets `getPhaseForWindow` below check whether a block's time
 * window overlaps a bracket that already closed, not only ones still open.
 */
let closedBrackets: ClosedBracket[] = [];

/**
 * Mark a phase as started. Returns a token the caller must pass back to
 * `phaseFinished` — the token itself is the map key, so it identifies this
 * bracket uniquely even against a same-named sibling running concurrently.
 * Cost per call: one object allocation, one `Date.now()`/`toISOString()`
 * call, and one `Map.set` (O(1), no scan of any collection) — negligible
 * next to the runner/phase work it brackets. Measured against this PR's own
 * call site (dispatcher.ts's per-runner `runRunner`): a native ast-grep or
 * tree-sitter scan, or a subprocess spawn, is orders of magnitude more
 * expensive than one map insert.
 */
export function phaseStarted(phase: string): PhaseToken {
	const token: PhaseToken = { phase, startedAt: new Date().toISOString() };
	liveBrackets.set(token, true);
	return token;
}

/**
 * Close a bracket: removes it from `liveBrackets` (one `Map.delete`, O(1))
 * and records it on the closed-bracket ring, bounded to `CLOSED_BRACKET_CAP`
 * with the oldest entry dropped first — see the `closedBrackets` doc comment
 * above for why a closed history is load-bearing, not just nice-to-have
 * (#1723 review F3). `Map.delete` reports whether it actually removed
 * anything, so a stale or duplicate `phaseFinished` call (the token isn't
 * live — already closed, or never was) is a no-op and can't push a phantom
 * entry onto the closed ring.
 *
 * Callers MUST pair this with `phaseStarted` via try/finally — an exception
 * or an abandoned promise that skips this call leaves a phantom entry in
 * `liveBrackets` forever, silently misattributing every LATER loop_block to
 * stale work (catalog: a bracket that must clear on finish, never left to a
 * process-lifetime latch). `resetCurrentPhaseForSession` is the session-
 * boundary backstop for the case where even try/finally doesn't run (a torn-
 * down activation whose in-flight phase never gets a chance to unwind).
 */
export function phaseFinished(token: PhaseToken): void {
	if (!liveBrackets.delete(token)) return;
	closedBrackets = [
		{ phase: token.phase, startedAt: token.startedAt, closedAt: new Date().toISOString() },
		...closedBrackets,
	].slice(0, CLOSED_BRACKET_CAP);
}

/**
 * The OLDEST phase still executing, if any — the longest-running open
 * bracket, and so the one most likely to own a long block (#1723 review
 * F1/F2). For `loop_block` attribution specifically, prefer
 * `getPhaseForWindow` below instead: this function alone cannot see a phase
 * that already closed, which is exactly what happens for a synchronous block
 * by the time anything samples it (F3).
 */
export function getCurrentPhase(): PhaseToken | undefined {
	const oldest = liveBrackets.keys().next();
	return oldest.done ? undefined : oldest.value;
}

export interface PhaseWindowAttribution {
	phase: string;
	startedAt: string;
	/** True if this bracket was still open (live) at read time; false if it had already closed. */
	stillRunning: boolean;
	/** The bracket's full lifetime so far: (closedAt ?? now) − startedAt. */
	elapsedMs: number;
}

/**
 * Attribute a block's time window `[windowStartMs, windowEndMs]` to whichever
 * bracket — live OR recently closed — overlaps it the most (#1723 review,
 * F3: the decisive finding). A live bracket's end, for overlap purposes, is
 * "now" (it is still running); a closed bracket's end is its own `closedAt`.
 * Only a STRICTLY POSITIVE overlap is a candidate — a bracket that merely
 * touches a window edge (zero overlap) proves nothing and must not win.
 * Ties keep whichever candidate was found first (live brackets are scanned
 * oldest-first, then the closed ring newest-first), matching
 * `getCurrentPhase`'s "oldest wins" tie-break.
 *
 * This is the seam that makes the SYNCHRONOUS motivating case attributable at
 * all: the offending phase's `finally` (a microtask) always runs before
 * `turn_end` (a macrotask) samples, so by the time this is called the
 * bracket has typically already moved from `liveBrackets` to
 * `closedBrackets` — checking only the live set reads empty for exactly that
 * case, which is why `getCurrentPhase` alone was not enough.
 */
export function getPhaseForWindow(
	windowStartMs: number,
	windowEndMs: number,
): PhaseWindowAttribution | undefined {
	const nowMs = Date.now();
	let best: PhaseWindowAttribution | undefined;
	let bestOverlapMs = 0;

	const consider = (
		phase: string,
		startedAt: string,
		endMs: number,
		stillRunning: boolean,
	): void => {
		const startMs = Date.parse(startedAt);
		const overlapMs = Math.min(endMs, windowEndMs) - Math.max(startMs, windowStartMs);
		if (overlapMs <= 0) return;
		if (overlapMs > bestOverlapMs) {
			bestOverlapMs = overlapMs;
			best = { phase, startedAt, stillRunning, elapsedMs: endMs - startMs };
		}
	};

	for (const token of liveBrackets.keys()) {
		consider(token.phase, token.startedAt, nowMs, true);
	}
	for (const closed of closedBrackets) {
		consider(closed.phase, closed.startedAt, Date.parse(closed.closedAt), false);
	}
	return best;
}

/**
 * Test-only: the closed-bracket ring's actual storage length, mirroring
 * `_recentPhasesStorageLengthForTest` above — pins that `phaseFinished`'s
 * `.slice(0, CLOSED_BRACKET_CAP)` guard is intact independent of any
 * read-side behavior (#1723 review: "ring unbounded" mutation).
 */
export function _closedBracketsStorageLengthForTest(): number {
	return closedBrackets.length;
}

/**
 * Session-boundary backstop: unconditionally clears BOTH the live-bracket map
 * and the closed-bracket ring. `phaseFinished` is the normal clear path
 * (paired via try/finally at each call site), but this module's state is
 * process-lifetime, not session-scoped, so a phase abandoned mid-flight by a
 * torn-down activation (an abort that skips straight past the `finally`, a
 * session replaced mid-scan) would otherwise leave a phantom bracket live
 * forever — misattributing every loop_block in every LATER session to that
 * one stale phase.
 *
 * #1723 review F4 — placement is deliberate, and DIFFERENT from
 * `warmDispatchAtSessionStart()`: call this only once `session_start` has
 * confirmed it is running a FULL session start (`decideSessionStart(...)
 * .runFullSessionStart`), i.e. from BEHIND the #473 concurrent-secondary
 * gate, not before it. The reason is the opposite of what an unconditional,
 * "re-arm on every session_start" placement would give: this module's state
 * is process-shared across every concurrently-live activation in the same
 * process, exactly like the LSP fleet / runtime generation #473 already
 * protects — a concurrent secondary's `session_start` firing while the
 * PARENT activation has genuinely in-flight brackets must not wipe the
 * parent's live attribution out from under it. Only a real sequential
 * session replacement (new/resume/fork/reload confirmed by
 * `decideSessionStart`) may safely assume no other activation still owns
 * live brackets in this process. A concurrent secondary's OWN torn-down
 * brackets are still covered: each caller's `phaseFinished` runs in its own
 * try/finally, and if that activation is torn down hard enough to skip even
 * that, the accepted cost is a stale bracket that the NEXT full session start
 * clears — not a wrong clear of a sibling that is still working.
 */
export function resetCurrentPhaseForSession(): void {
	liveBrackets.clear();
	closedBrackets = [];
}

export function logLatency(entry: LatencyEntry): void {
	const ts = new Date().toISOString();
	if (entry.type === "phase" && entry.phase && !LAST_PHASE_EXCLUDED.has(entry.phase)) {
		recentPhases = [{ phase: entry.phase, ts }, ...recentPhases].slice(0, RECENT_PHASE_CAP);
	}
	if (isTestMode()) {
		return;
	}
	writer.log({ ...entry, ts, pid: process.pid });
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

/** Resolve once all enqueued latency writes are on disk (tests/shutdown). */
export function flushLatencyLog(): Promise<void> {
	return writer.flush();
}

export function clearLatencyLog(): void {
	// Enqueue the truncate in the same serialized queue so a clear cannot race a
	// pending drain. Await flushLatencyLog() if you need the file empty on disk.
	writer.truncate();
}
