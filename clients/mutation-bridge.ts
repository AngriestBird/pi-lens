/**
 * Generic mutation-recording bridge for pi-lens (#2423).
 *
 * ## Trust model — explicitly advisory
 *
 * Sibling of `clients/read-bridge.ts` and it inherits that module's trust
 * model verbatim: any code sharing this Node.js process already has full access
 * to pi-lens's internal state, so the bridge is not a security boundary. What
 * it provides is a stable API surface, one place for flag and scope checks, and
 * defensive validation that catches integration bugs early.
 *
 * ## What it is for
 *
 * `clients/mutating-tool.ts` classifies mutations pi-lens SEES as tool events.
 * A producer that writes a file some other way — a co-process extension with
 * its own registered tool, or pi-lens's own `ast_grep_replace` running
 * `--update-all` — is invisible to that path. It records the mutation here
 * instead, and the same downstream bookkeeping runs: read-guard staleness
 * stamp, turn-state modified ranges, an attributed change-log receipt, and a
 * DEFERRED autofix and format pass at `agent_settled`.
 *
 * Deferred, not immediate, is deliberate: a bulk rewrite usually touches many
 * files, and formatting each one as it lands fights the producer that is still
 * writing.
 *
 * Protocol (producer side)
 * ────────────────────────
 *
 *   const bridge = (globalThis as any)[Symbol.for("pi-lens:mutation-bridge")];
 *   bridge?.recordMutation({
 *     filePath,      // absolute path
 *     kind,          // "write" (whole file authored) or "edit" (part changed)
 *     touchedLines,  // optional [start, end], 1-based inclusive
 *     editRanges,    // optional [start, end][] for a scattered multi-range edit
 *     consumer,      // optional identifier, e.g. "my-extension"
 *   });
 *
 * Check `bridge.version` before calling. A bridge whose version you do not
 * recognize is unsupported. Calling before pi-lens is loaded, or when the guard
 * is disabled, is safe: the bridge is absent or the call is dropped.
 *
 * `recordMutation` returns `true` when pi-lens took the record and `false` when
 * it dropped it (malformed payload, out-of-scope path, or a bookkeeping error),
 * so a producer can count its own drops.
 *
 * Protocol (registration side, internal to pi-lens)
 * ──────────────────────────────────────────────────
 * `registerMutationBridge` is called once from the extension factory, next to
 * `registerReadBridge`, behind a module-level singleton guard so factory
 * re-activations do not mount a second bridge. Every dep is a GETTER resolved
 * at call time, so a replaced runtime or cache manager is picked up without
 * re-registration — the same live-getter discipline the read bridge uses.
 */
import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	classifyBridgeMutation,
	type BridgeMutationEntry,
	type MutatingToolClassification,
} from "./mutating-tool.js";
import { noteAgentMutation } from "./fix-run-restore.js";
import { noteMutationHandled } from "./observed-mutation.js";
import type { ProjectChangeSource } from "./project-changes.js";
import { getProcessBridge, registerProcessBridge } from "./process-bridge.js";
import { recordDroppedRead } from "./session-scope.js";
import {
	getIOBridge,
	type BridgeEntry,
	type MutationFacet,
} from "./io-bridge-contract.js";

/** Stable Symbol key — identical across module reloads in the same process. */
export const MUTATION_BRIDGE_KEY: unique symbol = Symbol.for(
	"pi-lens:mutation-bridge",
);

/** Payload a producer passes when recording a mutation. */
export type MutationBridgeEntry = BridgeMutationEntry;

/** The object mounted at `globalThis[MUTATION_BRIDGE_KEY]`. */
export interface MutationBridge {
	/**
	 * Bridge API version. Check this before calling `recordMutation` — if the
	 * version is not one you recognize, treat the bridge as unsupported.
	 */
	readonly version: 1;
	/** `true` when pi-lens recorded the mutation, `false` when it dropped it. */
	recordMutation(entry: MutationBridgeEntry): boolean;
}

/** The bookkeeping surfaces the bridge drives. Every one is optional-tolerant. */
export interface MutationBridgeDeps {
	getRuntime(): {
		turnIndex: number;
		telemetrySessionId?: string;
		/**
		 * The live read guard. Required: the real `RuntimeCoordinator` always
		 * exposes it (a lazily-built getter), and #3677's bound needs its
		 * `currentBranchEpoch` on every call.
		 */
		readGuard: {
			/** #3677: the live epoch a forwarded epoch is validated against. */
			currentBranchEpoch: number;
			recordWritten?: (
				filePath: string,
				opts?: { branchEpoch?: number; stampFileTime?: boolean },
			) => void;
		};
		recordProjectMutation?: (args: {
			filePath: string;
			source: ProjectChangeSource;
			cwd?: string;
			changedRange?: { start: number; end: number };
			onAppendError?: (err: unknown) => void;
		}) => unknown;
		deferMutation?: (
			filePath: string,
			cwd: string,
			toolName: string,
			turnStateCwd: string,
			kind: "autofix" | "format",
			ownerSessionId?: string,
			originCwd?: string,
			readGuardBranchEpoch?: number,
		) => boolean;
	};
	getCacheManager(): {
		addModifiedRange?: (
			filePath: string,
			range: { start: number; end: number },
			importsChanged: boolean,
			cwd: string,
			sessionId?: string | null,
		) => unknown;
	};
	/** Workspace root used for turn-state and change-log bookkeeping. */
	getProjectRoot(): string;
	/** Formatter/language root for this file — the deferred pass's cwd. */
	getDispatchCwd(filePath: string): string;
	/** Line count used when a `write` records no explicit range. */
	countFileLines(filePath: string): number;
	/**
	 * Return `true` when the entry should be recorded. Called on EVERY
	 * `recordMutation` invocation so flag and project-root changes take effect
	 * immediately without re-registration.
	 *
	 * Path-scope ONLY (ignored/vendor/#project-root) — deliberately does not
	 * consult `no-read-guard` (#2465). That flag decides whether the
	 * read-guard staleness stamp fires (`shouldStampReadGuard` below), not
	 * whether the write happened at all; folding it in here used to drop
	 * turn-state and the change-log receipt along with the stamp, the same
	 * conflation `clients/runtime-tool-result.ts` avoids by gating
	 * `readGuard.recordWritten` alone.
	 */
	isRecordable(filePath: string): boolean;
	/**
	 * Whether the read-guard staleness stamp (`runtime.readGuard.recordWritten`)
	 * should fire for this call. Optional — omitted (e.g. in tests that don't
	 * care) defaults to `true`, preserving the stamp-always behavior every
	 * existing caller had before #2465. `no-read-guard` is the ONLY thing that
	 * should make this `false`; it must never also affect `isRecordable`
	 * above, or turn-state/the receipt silently drop with it.
	 */
	shouldStampReadGuard?(): boolean;
	dbg?: (msg: string) => void;
}

function isValidRange(value: unknown): value is [number, number] {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [start, end] = value;
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 1 &&
		end >= start
	);
}

/**
 * Validate a raw entry from an untrusted caller. Deliberately lightweight, for
 * the same reason `read-bridge.ts` gives: this is an advisory protocol between
 * same-process extensions, so the goal is catching typos and bad numbers rather
 * than enforcing a boundary.
 */
export function isValidMutationEntry(
	entry: unknown,
): entry is MutationBridgeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;

	if (typeof e["filePath"] !== "string" || e["filePath"] === "") return false;

	const kind = e["kind"];
	if (kind !== "write" && kind !== "edit") return false;

	if (e["touchedLines"] !== undefined && !isValidRange(e["touchedLines"]))
		return false;

	const editRanges = e["editRanges"];
	if (editRanges !== undefined) {
		if (!Array.isArray(editRanges) || editRanges.length === 0) return false;
		if (!editRanges.every(isValidRange)) return false;
	}

	if (e["consumer"] !== undefined && typeof e["consumer"] !== "string")
		return false;

	if (
		e["importsChanged"] !== undefined &&
		typeof e["importsChanged"] !== "boolean"
	)
		return false;

	if (e["deferAutofix"] !== undefined && typeof e["deferAutofix"] !== "boolean")
		return false;

	// #2430: only the observational net's two values are accepted. An unknown
	// string is rejected rather than silently downgraded, so a producer that
	// invents a provenance learns about it instead of publishing a wrong one.
	const provenance = e["provenance"];
	if (
		provenance !== undefined &&
		provenance !== "observed" &&
		provenance !== "settled-sweep"
	)
		return false;

	return true;
}

/**
 * #3677: a foreign producer may pass the read guard's branch epoch it captured
 * before it awaited. Resolve it into the epoch the bridge forwards to both
 * consumers: `ReadGuard.recordWritten` (a concrete epoch makes the guard
 * refuse to credit a write that landed on a different branch, #3521) and
 * `RuntimeCoordinator.deferMutation`, whose `Math.max` merge a foreign value
 * must never reach (#3677's poison).
 *
 * Only an integer from 0 to the live guard's `currentBranchEpoch` is a
 * capture this scope can hold: `branchEpoch` only counts up within a scope.
 * Anything else is ignored for BOTH consumers, with one bounded degradation
 * record per session, the same fail-open-to-current treatment a producer that
 * omits the field gets. That includes a well-formed epoch ABOVE the live one
 * (#3763 item 5). #3677 round 3 read such a value as a dead session's capture
 * (a new `ReadGuard` restarts at 0 after `resetForSession`) and skipped the
 * stamp and the deferral, silently under `no-read-guard`. Session currency is
 * the entry's lineage since S3 (#3759): the one in-process producer that
 * sends an epoch, the settled sweep, sends the lineage it captured with it,
 * and the fence in {@link recordMutationThroughSeam} drops a dead session's
 * replay before this runs. A producer without a lineage cannot learn an epoch
 * at all (the bridge exposes none), so a value above the live one is
 * invented. Recorded once per session: the count is not the signal, the
 * producer bug is.
 */
function resolveReadGuardBranchEpoch(
	value: unknown,
	currentEpoch: number,
): number | undefined {
	if (value === undefined) return undefined;
	const wellFormed =
		typeof value === "number" && Number.isInteger(value) && value >= 0;
	if (wellFormed && value <= currentEpoch) return value;
	recordDegradationOnce({
		kind: "mutation-bridge-invalid-branch-epoch",
		subject: "readGuardBranchEpoch",
		// #3677 review round 1 F3: `typeof`, never `String(value)` — a
		// null-proto object has no `toString`, and the throw dropped the whole
		// record (turn state, receipt, deferral) out of the bridge's try.
		reason: wellFormed
			? `ignored a readGuardBranchEpoch above the live epoch (${value} > ${currentEpoch})`
			: `ignored a foreign readGuardBranchEpoch (typeof ${typeof value}) (current ${currentEpoch})`,
	});
	return undefined;
}

/**
 * The one range the change log records for this mutation. A multi-range edit
 * records its bounding box, matching how `runtime-tool-result.ts` collapses a
 * multi-hunk diff (`singleRange`) — the change log carries one range per entry.
 */
function resolveChangedRange(
	classification: MutatingToolClassification,
	deps: MutationBridgeDeps,
	filePath: string,
): { start: number; end: number } {
	if (classification.touchedLines) {
		const [start, end] = classification.touchedLines;
		return { start, end };
	}
	if (classification.editRanges && classification.editRanges.length > 0) {
		const starts = classification.editRanges.map(([start]) => start);
		const ends = classification.editRanges.map(([, end]) => end);
		return { start: Math.min(...starts), end: Math.max(...ends) };
	}
	// No range stated. A write replaced the whole file, and an edit whose ranges
	// the producer could not name is treated the same way: the safe
	// over-approximation is the entire file, never an empty set.
	return { start: 1, end: Math.max(1, deps.countFileLines(filePath)) };
}

/** Why a mutation record was not credited to live session state (#3654). */
export type MutationRecordReason =
	| "malformed"
	| "out-of-scope"
	| "stale-lineage"
	| "bookkeeping-error";

/** The full answer {@link recordMutationOutcome} gives (#3654). */
export interface MutationRecordOutcome {
	/** v1 `recordMutation()`'s boolean: the receipt/bookkeeping was taken. */
	recorded: boolean;
	/**
	 * v2 live-state acceptance. False only for a drop, or for a retired lineage
	 * when the caller asked to reject one (`rejectStaleLineage`).
	 */
	accepted: boolean;
	/** Present when `accepted` is false. */
	reason?: MutationRecordReason;
	/**
	 * Deferred kinds this call newly enqueued (a same-kind re-touch is silent),
	 * the exact population `clients/io-bridge.ts` publishes on `pi.events`.
	 */
	queued: ReadonlyArray<"autofix" | "format">;
}

/**
 * The mutation-recording body, exported so tests drive it against a real
 * `RuntimeCoordinator` and `CacheManager` without mounting the global
 * singleton.
 *
 * Returns the richer outcome (#3654) the unified bridge needs: the v1 boolean
 * the frozen shim still returns, the v2 live-state acceptance, and the kinds
 * this call newly enqueued for the deferred pass.
 *
 * `rejectStaleLineage` is the one behavioral knob. A retired lineage still
 * runs the same bookkeeping (receipt, handled mark, deferral skip) either way;
 * v2 reports it as `accepted:false, reason:"stale-lineage"` while the frozen
 * v1 shim keeps the historical `recorded:true` it has always returned.
 */
/** The two drop answers that carry no bookkeeping. */
function rejectedOutcome(
	reason: "malformed" | "out-of-scope",
): MutationRecordOutcome {
	return { recorded: false, accepted: false, reason, queued: [] };
}

/** Everything the bookkeeping stages share once an entry is admitted. */
interface MutationBookkeepingContext {
	entry: MutationBridgeEntry;
	classification: ReturnType<typeof classifyBridgeMutation>;
	deps: MutationBridgeDeps;
	runtime: ReturnType<MutationBridgeDeps["getRuntime"]>;
	filePath: string;
	projectRoot: string;
	dispatchCwd: string;
}

/**
 * The live-state decision plus the read-guard staleness stamp (#3620/#3709,
 * #2465, #3525). Returns whether the producer's session is still live and the
 * resolved branch epoch the deferred queue should carry (#3677).
 */
function stampLiveMutation(
	ctx: MutationBookkeepingContext,
	stampReadGuard: boolean,
): { sessionLive: boolean; stamp: number | undefined } {
	const { entry, classification, runtime, filePath } = ctx;
	const lineage = entry.lineage;
	let sessionLive = true;
	if (
		lineage !== undefined &&
		lineage.guardedWrite(filePath, () => true) !== true
	) {
		sessionLive = false;
		// The write's own queue-time epoch is the entry's, when it has one.
		if (stampReadGuard) {
			recordDroppedRead(
				lineage,
				entry.provenance ?? classification.toolName,
				entry.readGuardBranchEpoch ?? lineage.branchEpoch,
			);
		}
	}
	// #3677: resolve the foreign epoch BEFORE either consumer sees it, so the
	// `Math.max` merge of the deferred queue never gets a value this scope
	// cannot hold. A dead session's replay was dropped above, unresolved.
	const stamp = sessionLive
		? resolveReadGuardBranchEpoch(
				entry.readGuardBranchEpoch,
				runtime.readGuard.currentBranchEpoch,
			)
		: undefined;
	// 1. Staleness stamp: the file changed under pi-lens, so a later edit is
	//    judged by read coverage rather than by this write.
	if (sessionLive && stampReadGuard) {
		runtime.readGuard.recordWritten?.(filePath, {
			...(stamp !== undefined && { branchEpoch: stamp }),
			// #3525: settled-sweep drift is unattributed, and the agent never
			// saw it: authorship, not FileTime.
			...(entry.provenance === "settled-sweep" && { stampFileTime: false }),
		});
	}
	return { sessionLive, stamp };
}

/** Turn state (2) and the attributed change-log receipt (3), then the handled mark. */
function applyTurnAndChangeLog(
	ctx: MutationBookkeepingContext,
	sessionLive: boolean,
): void {
	const { entry, classification, deps, runtime, filePath, projectRoot } = ctx;
	const changedRange = resolveChangedRange(classification, deps, filePath);
	if (sessionLive) {
		deps
			.getCacheManager()
			.addModifiedRange?.(
				filePath,
				changedRange,
				entry.importsChanged ?? false,
				projectRoot,
				runtime.telemetrySessionId,
			);
	}
	runtime.recordProjectMutation?.({
		filePath,
		source: `agent-tool:${classification.toolName}`,
		cwd: projectRoot,
		changedRange,
		onAppendError: (err) =>
			deps.dbg?.(`mutation_bridge: change log append failed: ${err}`),
	});
	// #2430: this file is now accounted for this run, so the `agent_settled`
	// sweep re-baselines it instead of reporting the same bytes as drift no tool
	// call explains. It sits OUTSIDE the `deferAutofix` guard below and must stay
	// there (#2465): "pi-lens accounted for this write" and "pi-lens will also
	// format this file later" are different questions.
	noteMutationHandled(filePath);
}

/**
 * 4. Deferred autofix and format at `agent_settled` — never immediate. Pushes
 * into the caller's array so a throw mid-loop keeps the kinds already queued.
 */
function queueDeferredMutation(
	ctx: MutationBookkeepingContext,
	sessionLive: boolean,
	stamp: number | undefined,
	queued: Array<"autofix" | "format">,
): void {
	const { entry, classification, runtime, filePath, projectRoot, dispatchCwd } =
		ctx;
	if (!sessionLive || entry.deferAutofix === false) return;
	for (const kind of ["autofix", "format"] as const) {
		const landed = runtime.deferMutation?.(
			filePath,
			dispatchCwd,
			classification.toolName,
			projectRoot,
			kind,
			runtime.telemetrySessionId,
			projectRoot,
			// #3521: the settled sweep's epoch, so a record it queues after
			// a /tree is not credited to the new branch. #3677: a value this
			// scope cannot hold is dropped (undefined), so the merge uses the
			// current epoch.
			stamp,
		);
		if (landed) queued.push(kind);
	}
}

/** The stages inside the producer's try: stamp, turn state, change log, deferral. */
function runMutationBookkeeping(
	ctx: MutationBookkeepingContext,
	queued: Array<"autofix" | "format">,
): boolean {
	const stampReadGuard = ctx.deps.shouldStampReadGuard?.() ?? true;
	const { sessionLive, stamp } = stampLiveMutation(ctx, stampReadGuard);
	applyTurnAndChangeLog(ctx, sessionLive);
	queueDeferredMutation(ctx, sessionLive, stamp, queued);
	return sessionLive;
}

export function recordMutationOutcome(
	entry: unknown,
	deps: MutationBridgeDeps,
	opts?: { rejectStaleLineage?: boolean },
): MutationRecordOutcome {
	if (!isValidMutationEntry(entry)) {
		deps.dbg?.("mutation_bridge: dropped malformed entry");
		return rejectedOutcome("malformed");
	}
	if (!deps.isRecordable(entry.filePath)) {
		deps.dbg?.(`mutation_bridge: out of scope ${entry.filePath}`);
		return rejectedOutcome("out-of-scope");
	}

	// #3598: an observed or bridged producer's write is an agent mutation a
	// running whole-package fixer must not erase. Read it before the bookkeeping.
	noteAgentMutation(entry.filePath);

	const ctx: MutationBookkeepingContext = {
		entry,
		classification: classifyBridgeMutation(entry),
		deps,
		runtime: deps.getRuntime(),
		filePath: entry.filePath,
		projectRoot: deps.getProjectRoot(),
		dispatchCwd: deps.getDispatchCwd(entry.filePath),
	};
	const queued: Array<"autofix" | "format"> = [];
	let sessionLive = true;
	try {
		sessionLive = runMutationBookkeeping(ctx, queued);
	} catch (err) {
		// Bookkeeping must never break a producer's own write path.
		deps.dbg?.(`mutation_bridge: recording failed for ${ctx.filePath}: ${err}`);
		return {
			recorded: false,
			accepted: false,
			reason: "bookkeeping-error",
			queued,
		};
	}
	const accepted = sessionLive || opts?.rejectStaleLineage !== true;
	return accepted
		? { recorded: true, accepted: true, queued }
		: { recorded: true, accepted: false, reason: "stale-lineage", queued };
}

/** The v1 `recordMutation()` boolean answer, over the same one body. */
export function recordMutationThroughSeam(
	entry: unknown,
	deps: MutationBridgeDeps,
): boolean {
	return recordMutationOutcome(entry, deps).recorded;
}

/** The v1-compat fields every v2 mutation facet threads through unchanged. */
function mutationPassthrough(entry: MutationBridgeEntry) {
	return {
		...(entry.deferAutofix !== undefined && {
			deferAutofix: entry.deferAutofix,
		}),
		...(entry.importsChanged !== undefined && {
			importsChanged: entry.importsChanged,
		}),
		...(entry.touchedLines !== undefined && {
			touchedLines: entry.touchedLines,
		}),
		...(entry.provenance !== undefined && {
			provenance: entry.provenance,
		}),
		...(entry.readGuardBranchEpoch !== undefined && {
			readGuardBranchEpoch: entry.readGuardBranchEpoch,
		}),
		...(entry.lineage !== undefined && { lineage: entry.lineage }),
	};
}

/**
 * The v1 entry as a v2 entry (#3654, D14). The frozen shim only calls this for
 * entries v2 can express (a `write`, or an `edit` that named its ranges), so
 * `editRanges` is always present on the `edit` branch.
 */
function toIOBridgeEntry(entry: MutationBridgeEntry): BridgeEntry {
	const mutate: MutationFacet =
		entry.kind === "write"
			? { kind: "write", ...mutationPassthrough(entry) }
			: {
					kind: "edit",
					ranges: entry.editRanges ?? [],
					...mutationPassthrough(entry),
				};
	return {
		filePath: entry.filePath,
		...(entry.consumer !== undefined && { consumer: entry.consumer }),
		mutate,
	};
}

/**
 * Mount the bridge singleton. Call once from inside the extension factory,
 * protected by the caller's module-level flag. Subsequent calls are no-ops
 * (first-wins, `clients/process-bridge.ts` owns the mount body — see that
 * module's header, #2437).
 */
export function registerMutationBridge(deps: MutationBridgeDeps): void {
	registerProcessBridge(MUTATION_BRIDGE_KEY, (): MutationBridge => ({
		version: 1 as const,
		recordMutation(entry: MutationBridgeEntry): boolean {
			// #3654: in a pi-lens process the unified bridge is mounted in the
			// same first-wins pass, so the frozen v1 shim gains v2 behavior
			// underneath (the `pilens:format:queued` publish, the richer drop
			// reasons). Malformed input and the one v1 shape v2 cannot express
			// (an `edit` with no named range) keep the original body, so no v1
			// observable changes (D14).
			const ioBridge = getIOBridge();
			if (ioBridge === undefined || !isValidMutationEntry(entry)) {
				return recordMutationThroughSeam(entry, deps);
			}
			if (entry.kind === "edit" && entry.editRanges === undefined) {
				return recordMutationThroughSeam(entry, deps);
			}
			const result = ioBridge.record(toIOBridgeEntry(entry));
			// v1 records a retired lineage's receipt and returns true; v2 reports
			// it as a live-state rejection. The shim keeps the v1 answer.
			return (
				result.mutate?.accepted === true ||
				result.mutate?.reason === "stale-lineage"
			);
		},
	}));
}

/**
 * The mounted bridge, or `undefined` when pi-lens has not registered one (or
 * a differently-versioned bridge is mounted, or the mounted value is missing
 * `recordMutation`).
 *
 * In-repo producers use this instead of reaching for `globalThis` themselves,
 * so there is one spelling of the key and one version check.
 */
export function getMutationBridge(): MutationBridge | undefined {
	const candidate = getProcessBridge<MutationBridge>(MUTATION_BRIDGE_KEY, 1);
	return typeof candidate?.recordMutation === "function"
		? candidate
		: undefined;
}
