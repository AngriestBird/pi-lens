/**
 * Unified File I/O Lifecycle Bridge v2 (#3654).
 *
 * One synchronous, non-throwing `record(entry)` covers file observation
 * (`read`), partial modification (`edit`), whole-file authorship (`write`),
 * and deletion (`delete`). A compound `{ mutate, read }` call is atomic: the
 * mutation facet runs strictly before the read facet, so a producer that
 * already wrote the bytes and then previews them never desynchronizes the
 * read guard's staleness stamp.
 *
 * The frozen v1 shims (`clients/read-bridge.ts`, `clients/mutation-bridge.ts`)
 * resolve this bridge through `clients/io-bridge-contract.ts` and delegate to
 * `record()` when it is mounted, keeping their v1 return types and keys (D14).
 *
 * Ownership: the mutation bookkeeping rule stays in `clients/mutation-bridge.ts`
 * (`recordMutationOutcome`); this module composes it with the read-guard and
 * delete lifecycle and never re-derives it. The read path uses the read
 * guard's own content-binding and in-memory-hash seams, and the delete path
 * mirrors `clients/runtime-tool-result.ts`'s confirmed-delete gates.
 *
 * Drops are returned synchronously as `RecordOutcome` AND recorded in the
 * degradation ledger as `io-bridge-read-dropped` / `io-bridge-mutate-dropped`
 * with subject `"${caller}:${reason}"`, so a monitor can join the log row to
 * the caller's own count (F5).
 */
import { recordDegradationOnce } from "./degradation-ledger.js";
import { publishFormatQueued } from "./format-events-publish.js";
import {
	IO_BRIDGE_SYMBOL,
	IO_BRIDGE_VERSION,
	type BridgeEntry,
	type LineHashMap,
	type LineRange,
	type MutationFacet,
	type PiLensIOBridge,
	type ReadFacet,
	type RecordOutcome,
	type RecordReason,
	type RecordResult,
} from "./io-bridge-contract.js";
import {
	recordMutationOutcome,
	type MutationBridgeDeps,
} from "./mutation-bridge.js";
import {
	captureReadContentBinding,
	deliveredLineEvidence,
	type ReadContentBinding,
	type ReadRecord,
} from "./read-guard.js";
import { registerProcessBridge } from "./process-bridge.js";

export {
	IO_BRIDGE_SYMBOL,
	IO_BRIDGE_VERSION,
	type BridgeEntry,
	type RecordOutcome,
	type RecordReason,
};

export { getIOBridge } from "./io-bridge-contract.js";

/** The read-guard surface the bridge drives. */
export interface ReadGuardBridgeSurface {
	recordRead(record: ReadRecord, opts?: { captureLineHashes?: boolean }): void;
	forgetPath(filePath: string): void;
	hasKnownPath(filePath: string): boolean;
}

/** The bookkeeping surfaces the bridge drives, on top of the mutation bridge's. */
export interface IOBridgeDeps extends MutationBridgeDeps {
	/** The live read guard; resolved at call time. */
	getReadGuard(): ReadGuardBridgeSurface;
	/** The agent-turn index for a recorded read. */
	getTurnIndex(): number;
	/** The agent-write index at record time. */
	peekWriteIndex(): number;
	/**
	 * The live lens flag getter (`no-read-guard`, `no-lsp`). `bridge` names the
	 * owning bridge for the stale-ctx diagnostic ("<bridge>-bridge"). The v1
	 * read shim runs its own recordability gate before delegating (D14: it must
	 * keep the `"read-bridge"` subject and the near-match stale rethrow), so
	 * the read facet attributes its duplicate read `"read"` and the ledger's
	 * `kind\0subject` once-key collapses the two into one row. Omitted means
	 * the native v2 surface (`"io-bridge"`).
	 */
	getFlag(
		name: string,
		bridge?: "read" | "mutation" | "io",
	): boolean | string | undefined;
	/** Delete gate 1 — vendor / outside every workspace root. */
	isExternalOrVendorFile(filePath: string): boolean;
	/** Delete gate 2 — ignored by a project ignore file. */
	isPathIgnoredByProject(filePath: string): boolean;
	/** Delete gate 4 — tell LSP clients the watched file is gone (type 3). */
	notifyExternalFileChange(
		filePath: string,
		type: number,
	): void | Promise<void>;
	/** The filesystem probes the bridge performs itself. */
	nodeFs: {
		existsSync(filePath: string): boolean;
		statSync(filePath: string): { size: number };
	};
	/** Test seam for the deferred-format event; defaults to the real publisher. */
	publishFormatQueued?: typeof publishFormatQueued;
}

/** Mount the bridge singleton. First-wins, `clients/process-bridge.ts` owns the body. */
export function registerIOBridge(deps: IOBridgeDeps): void {
	registerProcessBridge(IO_BRIDGE_SYMBOL, (): PiLensIOBridge => ({
		version: IO_BRIDGE_VERSION,
		record(entry: BridgeEntry): RecordResult {
			return recordIOEntry(entry, deps);
		},
	}));
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidRange(value: unknown): value is LineRange {
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
 * Whether the raw entry carries a facet. A facet set to `undefined` is absent;
 * any other value (including a non-object) is present so it reaches its own
 * validation and reports `malformed` rather than being silently ignored.
 */
function hasFacet(
	raw: Record<string, unknown>,
	key: "read" | "mutate",
): boolean {
	return raw[key] !== undefined;
}

function readConsumer(raw: Record<string, unknown>): string {
	const caller = raw["consumer"];
	return typeof caller === "string" && caller !== "" ? caller : "unknown";
}

/**
 * A read-facet problem string, or `undefined` when valid. `ranges` is required;
 * `[]` is the explicit zero-line read. `content` is valid only with a single
 * range. Every `lineHashes` key must fall inside a declared range.
 */
/** `ranges` must be an array of 1-indexed `[start, end]` pairs. */
function readRangesProblem(ranges: unknown): string | undefined {
	if (!Array.isArray(ranges)) return "ranges must be an array";
	if (!ranges.every(isValidRange)) {
		return "ranges must be 1-indexed [start, end] with start <= end";
	}
	return undefined;
}

function readEvidenceProblem(evidence: unknown): string | undefined {
	if (evidence === undefined || evidence === "caller" || evidence === "disk") {
		return undefined;
	}
	return 'evidence must be "caller" or "disk"';
}

/** `content` is a string, and only a single range (or the explicit empty one) may carry it. */
function readContentProblem(
	content: unknown,
	declared: LineRange[],
): string | undefined {
	if (content === undefined) return undefined;
	if (typeof content !== "string") return "content must be a string";
	const singleRange = declared.length === 1;
	const explicitEmpty = declared.length === 0 && content === "";
	if (!singleRange && !explicitEmpty) {
		return "content is valid only with a single range";
	}
	return undefined;
}

function readSourceProblem(source: unknown): string | undefined {
	if (source === undefined || typeof source === "string") return undefined;
	return "source must be a string";
}

/** Every `lineHashes` key must be an integer line inside a declared range. */
function readLineHashesProblem(
	lineHashes: unknown,
	declared: LineRange[],
): string | undefined {
	if (lineHashes === undefined) return undefined;
	if (!isRecordObject(lineHashes) || Array.isArray(lineHashes)) {
		return "lineHashes must be an object keyed by line number";
	}
	for (const [key, value] of Object.entries(lineHashes)) {
		const line = Number(key);
		if (!Number.isInteger(line) || line < 1 || typeof value !== "string") {
			return `lineHashes[${key}] must map an integer line to a string hash`;
		}
		if (!declared.some(([start, end]) => line >= start && line <= end)) {
			return `lineHashes key ${key} falls outside every declared range`;
		}
	}
	return undefined;
}

function readFacetProblem(read: unknown): string | undefined {
	if (!isRecordObject(read)) return "read facet must be an object";
	const ranges = read["ranges"];
	const rangesProblem = readRangesProblem(ranges);
	if (rangesProblem !== undefined) return rangesProblem;
	const declared = ranges as LineRange[];
	return (
		readEvidenceProblem(read["evidence"]) ??
		readContentProblem(read["content"], declared) ??
		readSourceProblem(read["source"]) ??
		readLineHashesProblem(read["lineHashes"], declared)
	);
}

/** `kind` must be one of the three mutation verbs. */
function mutationKindProblem(kind: unknown): string | undefined {
	if (kind === "edit" || kind === "write" || kind === "delete") {
		return undefined;
	}
	return 'kind must be "edit", "write", or "delete"';
}

/** `edit` ranges are optional, but a present `ranges` must be a non-empty array. */
function editRangesProblem(
	mutate: Record<string, unknown>,
): string | undefined {
	if (mutate["kind"] !== "edit") return undefined;
	const ranges = mutate["ranges"];
	if (ranges === undefined) return undefined;
	if (!Array.isArray(ranges) || ranges.length === 0) {
		return "edit ranges must be a non-empty array";
	}
	return undefined;
}

function writeContentProblem(
	mutate: Record<string, unknown>,
): string | undefined {
	if (mutate["kind"] !== "write") return undefined;
	const writtenContent = mutate["writtenContent"];
	if (writtenContent === undefined || typeof writtenContent === "string") {
		return undefined;
	}
	return "writtenContent must be a string";
}

function booleanFieldProblem(value: unknown, name: string): string | undefined {
	if (value === undefined || typeof value === "boolean") return undefined;
	return `${name} must be a boolean`;
}

function touchedLinesProblem(value: unknown): string | undefined {
	if (value === undefined || isValidRange(value)) return undefined;
	return "touchedLines must be 1-indexed [start, end]";
}

function provenanceProblem(value: unknown): string | undefined {
	if (
		value === undefined ||
		value === "observed" ||
		value === "settled-sweep"
	) {
		return undefined;
	}
	return 'provenance must be "observed" or "settled-sweep"';
}

/**
 * A mutation-facet problem string, or `undefined` when valid. `edit` ranges
 * are optional (omitted means the v1 seam's whole-file over-approximation), but
 * a present `ranges` must be non-empty and well-formed. `readGuardBranchEpoch`
 * is deliberately NOT type-checked here: a malformed epoch is the mutation
 * seam's to record (`mutation-bridge-invalid-branch-epoch`) and fail open.
 */
function mutationFacetProblem(mutate: unknown): string | undefined {
	if (!isRecordObject(mutate)) return "mutate facet must be an object";
	const kindProblem = mutationKindProblem(mutate["kind"]);
	if (kindProblem !== undefined) return kindProblem;
	return (
		editRangesProblem(mutate) ??
		writeContentProblem(mutate) ??
		booleanFieldProblem(mutate["deferAutofix"], "deferAutofix") ??
		booleanFieldProblem(mutate["importsChanged"], "importsChanged") ??
		touchedLinesProblem(mutate["touchedLines"]) ??
		provenanceProblem(mutate["provenance"])
	);
}

function drop(
	facet: "read" | "mutate",
	caller: string,
	reason: RecordReason,
	detail: string,
): RecordOutcome {
	if (facet === "read") {
		recordDegradationOnce({
			kind: "io-bridge-read-dropped",
			subject: `${caller}:${reason}`,
			reason: detail,
		});
	} else {
		recordDegradationOnce({
			kind: "io-bridge-mutate-dropped",
			subject: `${caller}:${reason}`,
			reason: detail,
		});
	}
	return { accepted: false, reason };
}

/** The `lineHashes` a caller-mode read should store, or `undefined` for coverage-only. */
function selectLineHashes(
	read: ReadFacet,
	start: number,
	end: number,
): LineHashMap | undefined {
	const within = (hashes: LineHashMap): LineHashMap => {
		const picked: LineHashMap = {};
		for (const [key, value] of Object.entries(hashes)) {
			const line = Number(key);
			if (line >= start && line <= end) picked[line] = value;
		}
		return picked;
	};
	if (read.lineHashes !== undefined) return within(read.lineHashes);
	if (read.content !== undefined) {
		const derived = deliveredLineEvidence(read.content, start).lineHashes;
		return derived === undefined ? undefined : within(derived);
	}
	return undefined;
}

interface OneRangeRecord {
	filePath: string;
	requestedOffset: number;
	requestedLimit: number;
	effectiveOffset: number;
	effectiveLimit: number;
	source: string;
	turnIndex: number;
	writeIndex: number;
	lineHashes?: LineHashMap;
	contentBinding?: ReadContentBinding;
	captureLineHashes: boolean;
}

function recordOneRange(
	guard: ReadGuardBridgeSurface,
	args: OneRangeRecord,
): void {
	guard.recordRead(
		{
			filePath: args.filePath,
			requestedOffset: args.requestedOffset,
			requestedLimit: args.requestedLimit,
			effectiveOffset: args.effectiveOffset,
			effectiveLimit: args.effectiveLimit,
			expandedByLsp: false,
			turnIndex: args.turnIndex,
			writeIndex: args.writeIndex,
			timestamp: Date.now(),
			source: args.source,
			...(args.lineHashes !== undefined && { lineHashes: args.lineHashes }),
			...(args.contentBinding !== undefined && {
				contentBinding: args.contentBinding,
			}),
		},
		{ captureLineHashes: args.captureLineHashes },
	);
}

/** Shared, resolved inputs for the read facet's two recording branches. */
interface ReadRecordContext {
	read: ReadFacet;
	deps: IOBridgeDeps;
	filePath: string;
	source: string;
	guard: ReadGuardBridgeSurface;
	turnIndex: number;
	writeIndex: number;
}

/**
 * The explicit zero-line read: it credits whole-file coverage only for a genuinely
 * empty file; anything else would credit lines the agent never saw (#3652).
 * Returns a drop detail, or `undefined` when recorded.
 */
function recordZeroLineRead(ctx: ReadRecordContext): string | undefined {
	let size: number;
	try {
		size = ctx.deps.nodeFs.statSync(ctx.filePath).size;
	} catch (err) {
		return `${err}`;
	}
	if (size !== 0) {
		return `zero-line read of a non-empty file (${size} bytes)`;
	}
	recordOneRange(ctx.guard, {
		filePath: ctx.filePath,
		requestedOffset: 1,
		requestedLimit: 0,
		effectiveOffset: 1,
		effectiveLimit: Number.MAX_SAFE_INTEGER,
		source: ctx.source,
		turnIndex: ctx.turnIndex,
		writeIndex: ctx.writeIndex,
		captureLineHashes: false,
	});
	return undefined;
}

/**
 * One declared range in caller- or disk-evidence mode. Returns a drop detail, or
 * `undefined` when recorded; a disk read of an absent file is refused.
 */
function recordRange(
	ctx: ReadRecordContext,
	start: number,
	end: number,
): string | undefined {
	// A `MAX_SAFE_INTEGER` end is the v1 "whole file" spelling; keep the
	// requested limit identical to v1 rather than `end - start + 1`.
	const limit =
		end === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : end - start + 1;
	const base: OneRangeRecord = {
		filePath: ctx.filePath,
		requestedOffset: start,
		requestedLimit: limit,
		effectiveOffset: start,
		effectiveLimit: limit,
		source: ctx.source,
		turnIndex: ctx.turnIndex,
		writeIndex: ctx.writeIndex,
		captureLineHashes: ctx.read.evidence === "disk",
	};
	if (ctx.read.evidence === "disk") {
		if (!ctx.deps.nodeFs.existsSync(ctx.filePath)) {
			return `disk read of an absent file: ${ctx.filePath}`;
		}
		const binding = captureReadContentBinding(ctx.filePath, start, limit);
		recordOneRange(ctx.guard, {
			...base,
			...(binding !== undefined && { contentBinding: binding }),
		});
		return undefined;
	}
	const hashes = selectLineHashes(ctx.read, start, end);
	recordOneRange(ctx.guard, {
		...base,
		...(hashes !== undefined && { lineHashes: hashes }),
	});
	return undefined;
}

function recordReadFacet(
	raw: Record<string, unknown>,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	const problem = readFacetProblem(raw["read"]);
	if (problem !== undefined) return drop("read", caller, "malformed", problem);
	const read = raw["read"] as ReadFacet;
	const filePath = raw["filePath"];
	if (typeof filePath !== "string" || filePath === "") {
		return drop(
			"read",
			caller,
			"malformed",
			"filePath must be a non-empty string",
		);
	}
	if (deps.getFlag("no-read-guard", "read")) {
		return drop("read", caller, "no-read-guard", filePath);
	}
	if (!deps.isRecordable(filePath)) {
		return drop("read", caller, "out-of-scope", filePath);
	}

	const ctx: ReadRecordContext = {
		read,
		deps,
		filePath,
		source: read.source ?? `io-bridge:${caller}`,
		guard: deps.getReadGuard(),
		turnIndex: deps.getTurnIndex(),
		writeIndex: deps.peekWriteIndex(),
	};

	if (read.ranges.length === 0) {
		const detail = recordZeroLineRead(ctx);
		return detail === undefined
			? { accepted: true }
			: drop("read", caller, "bookkeeping-error", detail);
	}

	for (const [start, end] of read.ranges) {
		try {
			const detail = recordRange(ctx, start, end);
			if (detail !== undefined) {
				return drop("read", caller, "bookkeeping-error", detail);
			}
		} catch (err) {
			return drop("read", caller, "bookkeeping-error", `${err}`);
		}
	}
	return { accepted: true };
}

function publishQueued(
	filePath: string,
	mutate: MutationFacet,
	deps: IOBridgeDeps,
	queued: ReadonlyArray<"autofix" | "format">,
): void {
	const publish = deps.publishFormatQueued ?? publishFormatQueued;
	try {
		publish({
			filePath,
			cwd: deps.getDispatchCwd(filePath),
			tool: mutate.kind === "write" ? "write" : "edit",
			kinds: [...queued],
			...(deps.dbg !== undefined && { dbg: deps.dbg }),
		});
	} catch (err) {
		deps.dbg?.(
			`io_bridge: format-queued publish failed for ${filePath}: ${err}`,
		);
	}
}

function recordDeleteFacet(
	filePath: string,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	// Enclosing gate (RFC D3). `no-lsp` is read again below, where it suppresses
	// only the LSP notification — the eviction still runs (RFC §6).
	if (deps.getFlag("no-read-guard", "mutation")) {
		return drop("mutate", caller, "no-read-guard", filePath);
	}
	// Inner confirmed-delete gates, in `runtime-tool-result.ts` production order.
	if (deps.isExternalOrVendorFile(filePath)) {
		return drop("mutate", caller, "out-of-scope", filePath);
	}
	if (deps.isPathIgnoredByProject(filePath)) {
		return drop("mutate", caller, "ignored", filePath);
	}
	const guard = deps.getReadGuard();
	const tracked = guard.hasKnownPath(filePath);
	const exists = deps.nodeFs.existsSync(filePath);
	// Untracked and already absent: nothing to evict, nothing to notify.
	if (!tracked && !exists) return { accepted: true };
	// Still on disk: the on-disk delete must precede the bridge call.
	if (exists) {
		return drop(
			"mutate",
			caller,
			"bookkeeping-error",
			`delete confirmed for a file still on disk: ${filePath}`,
		);
	}
	guard.forgetPath(filePath);
	if (!deps.getFlag("no-lsp", "mutation")) {
		try {
			void Promise.resolve(deps.notifyExternalFileChange(filePath, 3)).catch(
				(err) => {
					deps.dbg?.(
						`io_bridge: external-delete notify failed for ${filePath}: ${err}`,
					);
				},
			);
		} catch (err) {
			deps.dbg?.(
				`io_bridge: external-delete notify threw for ${filePath}: ${err}`,
			);
		}
	}
	return { accepted: true };
}

function recordMutateFacet(
	raw: Record<string, unknown>,
	caller: string,
	deps: IOBridgeDeps,
): RecordOutcome {
	const problem = mutationFacetProblem(raw["mutate"]);
	if (problem !== undefined) {
		return drop("mutate", caller, "malformed", problem);
	}
	const mutate = raw["mutate"] as MutationFacet;
	const filePath = raw["filePath"];
	if (typeof filePath !== "string" || filePath === "") {
		return drop(
			"mutate",
			caller,
			"malformed",
			"filePath must be a non-empty string",
		);
	}
	if (mutate.kind === "delete") {
		return recordDeleteFacet(filePath, caller, deps);
	}
	// edit/write: the mutation bookkeeping owner runs the seam (scope gate,
	// lineage fence, stamp, turn state, receipt, deferral). This module only
	// translates the facet and turns the outcome into v2 vocabulary.
	const v1Entry: Record<string, unknown> = {
		filePath,
		kind: mutate.kind,
	};
	// #3654/#2465: the mutation owner derives the change-log source
	// (`agent-tool:<name>`) from the entry's `consumer`, so a v1 caller's
	// producer identity must ride along. Without this the v2 translation
	// reported every v1 producer as `agent-tool:unknown`.
	const rawProducer = raw["consumer"];
	if (typeof rawProducer === "string" && rawProducer !== "") {
		v1Entry["consumer"] = rawProducer;
	}
	const passthrough = raw["mutate"] as Record<string, unknown>;
	const editRanges = passthrough["ranges"];
	if (mutate.kind === "edit" && editRanges !== undefined) {
		v1Entry["editRanges"] = editRanges;
	}
	for (const key of [
		"touchedLines",
		"deferAutofix",
		"importsChanged",
		"provenance",
		"readGuardBranchEpoch",
		"lineage",
	] as const) {
		if (passthrough[key] !== undefined) v1Entry[key] = passthrough[key];
	}
	const outcome = recordMutationOutcome(v1Entry, deps, {
		rejectStaleLineage: true,
	});
	if (outcome.queued.length > 0) {
		publishQueued(filePath, mutate, deps, outcome.queued);
	}
	if (!outcome.accepted) {
		const reason: RecordReason = outcome.reason ?? "bookkeeping-error";
		return drop("mutate", caller, reason, filePath);
	}
	return { accepted: true };
}

/**
 * Wrap one facet so a bookkeeping surprise becomes a `bookkeeping-error`
 * outcome (D9: `record()` never throws) without silencing the other facet.
 */
function safeFacet(
	caller: string,
	facet: "read" | "mutate",
	run: () => RecordOutcome,
): RecordOutcome {
	try {
		return run();
	} catch (err) {
		return drop(facet, caller, "bookkeeping-error", `${err}`);
	}
}

function recordIOEntry(raw: BridgeEntry, deps: IOBridgeDeps): RecordResult {
	if (!isRecordObject(raw)) {
		const detail = "entry must be an object";
		return {
			read: drop("read", "unknown", "malformed", detail),
			mutate: drop("mutate", "unknown", "malformed", detail),
		};
	}
	const caller = readConsumer(raw);
	const hasRead = hasFacet(raw, "read");
	const hasMutate = hasFacet(raw, "mutate");

	if (!hasRead && !hasMutate) {
		const detail = "entry carries no read or mutate facet";
		return {
			read: drop("read", caller, "malformed", detail),
			mutate: drop("mutate", caller, "malformed", detail),
		};
	}

	// D3 negative path: deleting while binding a read is contradictory, and both
	// facets are malformed.
	if (
		hasMutate &&
		hasRead &&
		isRecordObject(raw["mutate"]) &&
		raw["mutate"]["kind"] === "delete"
	) {
		const detail = "delete cannot be combined with read";
		return {
			read: drop("read", caller, "malformed", detail),
			mutate: drop("mutate", caller, "malformed", detail),
		};
	}

	// Atomic ordering: mutate strictly before read.
	const result: RecordResult = {};
	if (hasMutate) {
		result.mutate = safeFacet(caller, "mutate", () =>
			recordMutateFacet(raw, caller, deps),
		);
	}
	if (hasRead) {
		result.read = safeFacet(caller, "read", () =>
			recordReadFacet(raw, caller, deps),
		);
	}
	return result;
}
