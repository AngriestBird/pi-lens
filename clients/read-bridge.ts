/**
 * Generic read-recording bridge for pi-lens.
 *
 * ## Trust model — explicitly advisory
 *
 * This bridge is an **advisory, trust-based protocol** for same-process Pi
 * extensions. Any code sharing the same Node.js process already has full
 * access to pi-lens's internal state, so the bridge cannot and does not
 * provide a meaningful security boundary. What it *does* provide is:
 *
 * - A stable, versioned, forward-compatible API surface so extensions do not
 *   need to import pi-lens internals directly.
 * - A single place for flag/scope checks (no-read-guard, ignored paths).
 * - Basic defensive validation to catch integration bugs early (wrong
 *   version, malformed payload, impossible timestamps).
 *
 * Mounts a `ReadBridge` object at `globalThis[READ_BRIDGE_KEY]` that any
 * co-process extension can call to register a file read against pi-lens's
 * read-guard — without either party needing to know about the other.
 *
 * Protocol (producer side)
 * ────────────────────────
 * A co-process Pi extension that performs file reads outside pi-lens's
 * awareness (e.g. via a custom registered tool) can forward those reads so
 * that a subsequent `edit` call on the same file is not blocked by the
 * read-before-edit guard:
 *
 *   const bridge = (globalThis as any)[Symbol.for("pi-lens:read-bridge")];
 *   bridge?.recordRead({
 *     version: 1,        // protocol version — must equal READ_BRIDGE_VERSION
 *     filePath,          // absolute path
 *     requestedOffset,   // 1-indexed first line (default 1)
 *     requestedLimit,    // line count, or undefined for the whole file
 *     timestamp,         // Date.now() at read time
 *   });
 *
 * Entries that fail basic sanity checks (unknown version, non-string path,
 * non-finite numbers, or a timestamp more than 60 s in the future) are
 * silently dropped — they indicate an integration bug in the caller.
 *
 * Calling before pi-lens is loaded, or when the guard is disabled via
 * `PI_LENS_NO_READ_GUARD`, is safe — the bridge is absent or the call is
 * silently dropped.
 *
 * Protocol (registration side, internal to pi-lens)
 * ──────────────────────────────────────────────────
 * `registerReadBridge` is called once from inside the extension factory
 * (after `getLensFlag` is available) via the `_readBridgeRegistered`
 * singleton guard so that factory re-activations in the same process do not
 * mount a second bridge.
 *
 * The `isRecordable` predicate is re-evaluated on every `recordRead` call
 * using the *current* activation's flag getter (stored in a module-level
 * holder refreshed on every factory activation — same pattern as
 * `_turnSummaryEmitCtx`), so flag changes take effect immediately.
 */

/** Stable Symbol key — identical across module reloads in the same process. */
export const READ_BRIDGE_KEY: unique symbol = Symbol.for("pi-lens:read-bridge");

/** Current protocol version. Callers must pass this exact value. */
export const READ_BRIDGE_VERSION = 1 as const;

/** How far ahead of `Date.now()` a caller-supplied timestamp may be (ms). */
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 60_000;

/** Payload a producer passes when recording a read. */
export interface ReadBridgeEntry {
	/**
	 * Protocol version — must equal `READ_BRIDGE_VERSION` (currently `1`).
	 * Entries with an unknown version are silently dropped so callers built
	 * against a future version degrade gracefully on an older pi-lens.
	 */
	version: 1;
	/** Absolute path to the file that was read. */
	filePath: string;
	/** First line read (1-indexed). Defaults to 1 when no offset was given. */
	requestedOffset: number;
	/**
	 * Number of lines read. `undefined` means the whole file was requested;
	 * pi-lens will treat the effective limit as the full file length.
	 */
	requestedLimit: number | undefined;
	/** Unix timestamp (ms) captured when the read was initiated. */
	timestamp: number;
}

/** The object mounted at `globalThis[READ_BRIDGE_KEY]`. */
export interface ReadBridge {
	recordRead(entry: ReadBridgeEntry): void;
}

interface BridgeDeps {
	getReadGuard(): {
		recordRead(record: {
			filePath: string;
			requestedOffset: number;
			requestedLimit: number;
			effectiveOffset: number;
			effectiveLimit: number;
			expandedByLsp: boolean;
			turnIndex: number;
			writeIndex: number;
			timestamp: number;
		}): void;
	};
	getTurnIndex(): number;
	peekWriteIndex(): number;
	/**
	 * Return `true` when the entry should be forwarded to the read-guard.
	 * Called on every `recordRead` invocation so flag / project-root changes
	 * take effect immediately without re-registration.
	 */
	isRecordable(filePath: string): boolean;
}

/**
 * Validate a raw entry from an untrusted caller.
 * Returns `true` when the entry is structurally sound and safe to forward.
 *
 * Validation is deliberately lightweight — this is an advisory protocol
 * between same-process extensions (see the module-level trust-model note).
 * The goal is to catch integration bugs (wrong version, typo'd fields,
 * clock-skew bugs) early rather than to enforce a security boundary.
 */
function isValidEntry(entry: unknown): entry is ReadBridgeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;

	// Protocol version — drop unknown versions silently so callers built
	// against a future version degrade gracefully on an older pi-lens.
	if (e["version"] !== READ_BRIDGE_VERSION) return false;

	// filePath must be a non-empty string (absolute paths are expected but
	// we don't re-resolve here — `isRecordable` handles scope checks).
	if (typeof e["filePath"] !== "string" || e["filePath"] === "") return false;

	// requestedOffset must be a finite integer ≥ 1.
	const offset = e["requestedOffset"];
	if (
		typeof offset !== "number" ||
		!Number.isFinite(offset) ||
		offset < 1 ||
		!Number.isInteger(offset)
	)
		return false;

	// requestedLimit must be undefined or a finite positive integer.
	const limit = e["requestedLimit"];
	if (limit !== undefined) {
		if (
			typeof limit !== "number" ||
			!Number.isFinite(limit) ||
			limit < 1 ||
			!Number.isInteger(limit)
		)
			return false;
	}

	// timestamp must be a finite number not significantly in the future.
	// Stale timestamps are accepted — the guard handles its own recency logic.
	const ts = e["timestamp"];
	if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
	if (ts > Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS) return false;

	return true;
}

/**
 * Mount the bridge singleton. Call once from inside the extension factory
 * (protected by the `_readBridgeRegistered` module-level flag).
 * Subsequent calls are no-ops.
 */
export function registerReadBridge(deps: BridgeDeps): void {
	if ((globalThis as any)[READ_BRIDGE_KEY]) return; // already registered

	const bridge: ReadBridge = {
		recordRead(entry: ReadBridgeEntry): void {
			// Validate the payload before doing anything else — this catches
			// integration bugs in callers (wrong version, malformed fields,
			// impossible timestamps).
			if (!isValidEntry(entry)) return;

			if (!deps.isRecordable(entry.filePath)) return;

			const offset = entry.requestedOffset;
			// When no limit is given treat the whole file as covered — the guard
			// clips to the actual line count via its own file-length probe.
			const limit = entry.requestedLimit ?? Number.MAX_SAFE_INTEGER;

			deps.getReadGuard().recordRead({
				filePath: entry.filePath,
				requestedOffset: offset,
				requestedLimit: limit,
				effectiveOffset: offset,
				effectiveLimit: limit,
				expandedByLsp: false,
				turnIndex: deps.getTurnIndex(),
				writeIndex: deps.peekWriteIndex(),
				timestamp: entry.timestamp,
			});
		},
	};

	(globalThis as any)[READ_BRIDGE_KEY] = bridge;
}
