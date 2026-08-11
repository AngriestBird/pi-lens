/**
 * Generic read-recording bridge for pi-lens.
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
 *     filePath,          // absolute path
 *     requestedOffset,   // 1-indexed first line (default 1)
 *     requestedLimit,    // line count, or undefined for the whole file
 *     timestamp,         // Date.now() at read time
 *   });
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

/** Payload a producer passes when recording a read. */
export interface ReadBridgeEntry {
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
 * Mount the bridge singleton. Call once from inside the extension factory
 * (protected by the `_readBridgeRegistered` module-level flag).
 * Subsequent calls are no-ops.
 */
export function registerReadBridge(deps: BridgeDeps): void {
	if ((globalThis as any)[READ_BRIDGE_KEY]) return; // already registered

	const bridge: ReadBridge = {
		recordRead(entry: ReadBridgeEntry): void {
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
