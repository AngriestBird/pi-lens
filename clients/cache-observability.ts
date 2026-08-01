/**
 * Prompt-cache observability (#1018).
 *
 * Two provider-independent signals, both sinking into ~/.pi-lens/latency.log
 * via {@link logLatency} (matching the neighboring `type: "phase"` records):
 *
 *   1. Response-side cache usage (`cache_usage`) — on each assistant
 *      `message_end`, record the provider-reported token/cost breakdown so a
 *      session's actual cacheRead/cacheWrite behavior is queryable after the
 *      fact. This is what the provider DID, not what we hoped it would do.
 *
 *   2. Request-side prefix stability (`cache_prefix_break`) — a content hash of
 *      `messages[0]` observed on every `context` call. After #1016 the first
 *      message must stay byte-stable across a whole session; a logged CHANGE
 *      flags that something (pi-lens or otherwise) broke the cache prefix, which
 *      would silently invalidate the entire prompt-cache on every prefix-caching
 *      provider. Pure observation — it never alters context injection.
 *
 * Both paths are defensive: `usage` (and its fields) may be absent on older
 * hosts or non-assistant messages, so every access is guarded and the handlers
 * never throw — on error they `dbg(...)` and no-op, like the other index.ts
 * event handlers.
 */
import { createHash } from "node:crypto";
import { logLatency } from "./latency-logger.js";

/** Shape we defensively read off an assistant `AgentMessage` (see pi-ai types). */
interface AssistantUsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

interface AssistantMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	responseModel?: unknown;
	usage?: unknown;
}

/**
 * Part 1 — log one `cache_usage` record for an assistant `message_end` that
 * carries a `usage`. Provider/model come straight off the message itself
 * (`AssistantMessage.provider` / `.model` in pi-ai) — no dependency on the
 * runtime telemetry identity. Skips silently (no record) when the message is
 * not an assistant message or has no usage; never logs a zeros-only record for
 * a message that simply lacks usage.
 */
export function logCacheUsage(
	message: unknown,
	dbg?: (msg: string) => void,
): void {
	try {
		if (!message || typeof message !== "object") return;
		const msg = message as AssistantMessageLike;
		// Only assistant messages carry LLM usage; tool-result / user messages
		// (and unknown custom AgentMessage variants) are skipped.
		if (msg.role !== "assistant") return;
		const usage = msg.usage;
		if (!usage || typeof usage !== "object") return;
		const u = usage as AssistantUsageLike;
		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_usage",
			durationMs: 0,
			metadata: {
				provider: typeof msg.provider === "string" ? msg.provider : undefined,
				model: typeof msg.model === "string" ? msg.model : undefined,
				cacheRead: u.cacheRead,
				cacheWrite: u.cacheWrite,
				input: u.input,
				output: u.output,
				// `Usage.cost` is a breakdown object; the total is the headline number.
				cost: u.cost?.total,
			},
		});
	} catch (err) {
		dbg?.(`cache-usage: failed to log message_end usage: ${err}`);
	}
}

/**
 * Content hash of the first transcript message. Stable for identical content
 * (role + content are serialized in a fixed order), so a changing hash means
 * `messages[0]` actually changed byte-for-byte.
 */
function hashFirstMessage(first: { role?: unknown; content?: unknown }): string {
	const serialized = JSON.stringify({ role: first.role, content: first.content });
	return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Per-session baseline hash of `messages[0]`, keyed by the STABLE pi session id
 * (`ctx.sessionManager.getSessionId()`). A single module-scoped var was wrong:
 * in ONE process, multiple logical conversations touch this module, and they
 * must not share a baseline —
 *   - new / fork / a concurrent in-process subagent (#473) is a DIFFERENT id →
 *     its OWN independent baseline, never compared against another id's (else a
 *     benign session boundary logs a spurious `cache_prefix_break`, and a
 *     concurrent subagent + its parent stomp each other's baseline, each
 *     emitting a false positive — fatal for a signal whose value is trust);
 *   - resume / reload reuse the SAME id → the baseline persists in-process, so a
 *     genuine break induced by the resume is still caught (no blinding reset).
 *
 * Bounded as an insertion-ordered LRU (evict oldest-inserted past the cap) so a
 * long-lived process cycling through many sessions can't grow this unbounded.
 */
const MAX_TRACKED_SESSIONS = 32;
const prefixHashBySession = new Map<string, string>();

/**
 * Bucket key used when no session id is available (undefined/empty). Degrades
 * gracefully to the old single-var semantics — one shared baseline — rather than
 * throwing or dropping the signal.
 */
const NO_SESSION_KEY = "<no-session>";

/**
 * Store `hash` for `key`, refreshing its LRU recency (re-insert moves it to the
 * newest position since `Map` preserves insertion order) and evicting the
 * oldest-inserted entries once the cap is exceeded.
 */
function recordSessionHash(key: string, hash: string): void {
	prefixHashBySession.delete(key);
	prefixHashBySession.set(key, hash);
	while (prefixHashBySession.size > MAX_TRACKED_SESSIONS) {
		const oldest = prefixHashBySession.keys().next().value;
		if (oldest === undefined) break;
		prefixHashBySession.delete(oldest);
	}
}

/**
 * Part 2 — observe `messages[0]` stability turn-over-turn, keyed by session id.
 * Logs a baseline the first time it sees a non-empty transcript FOR A GIVEN
 * session id, then logs a `cache_prefix_break` whenever that same session's
 * first-message hash changes. Pure observation: it never inspects or mutates
 * anything but its own per-session hash map, and never throws.
 *
 * `sessionId` should be pi's STABLE id (`ctx.sessionManager.getSessionId()`),
 * which uniquely identifies the CURRENTLY-firing session: a concurrent
 * in-process subagent runs its own `AgentSession`/`sessionManager`, so its
 * `context` calls carry a DIFFERENT id than the parent's and get their own
 * baseline. (`runtime.telemetrySessionId` cannot be used here: per the #473
 * guard a concurrent secondary skips `updateRuntimeIdentityFromEvent`, so that
 * process-global singleton stays pinned to the PARENT — it would collapse
 * parent and subagent onto one baseline.) Residual limitation: if the host ever
 * does NOT supply a stable id, all such sessions collapse onto `NO_SESSION_KEY`
 * and behave like the old single-var (a concurrent subagent could then still
 * cross-contaminate) — accepted as graceful degradation, not silently perfect.
 *
 * Does nothing on an empty transcript (nothing to anchor a prefix to yet).
 */
export function observeCachePrefix(
	messages: ReadonlyArray<{ role?: unknown; content?: unknown }> | undefined,
	turnIndex: number,
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
	dbg?: (msg: string) => void,
): void {
	try {
		if (!messages || messages.length === 0) return;
		const first = messages[0];
		if (!first || typeof first !== "object") return;
		const key = sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
		const currentHash = hashFirstMessage(first);
		const previousHash = prefixHashBySession.get(key);
		if (previousHash === undefined) {
			// Baseline: record this session's starting prefix so a later break has a
			// reference point in the log. `previousHash: null` marks the baseline.
			recordSessionHash(key, currentHash);
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					turnIndex,
					previousHash: null,
					currentHash,
					baseline: true,
					sessionId: key,
					sessionRole,
				},
			});
			return;
		}
		if (currentHash !== previousHash) {
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					turnIndex,
					previousHash,
					currentHash,
					sessionId: key,
					sessionRole,
				},
			});
		}
		// Refresh recency (and update the stored hash after a break) so an active
		// session stays warm in the LRU and isn't evicted while still in use.
		recordSessionHash(key, currentHash);
	} catch (err) {
		dbg?.(`cache-prefix: failed to observe messages[0]: ${err}`);
	}
}

/**
 * Drop a single session's prefix baseline. Called from the `session_shutdown`
 * handler (primary path only — the concurrent-secondary guard there returns
 * first, and the LRU cap backstops any secondary entry left behind) so an ended
 * conversation's entry is reclaimed promptly rather than only when the LRU
 * evicts it. Idempotent and never throws.
 */
export function clearCachePrefixSession(sessionId?: string): void {
	const key = sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
	prefixHashBySession.delete(key);
}

/** Clear all per-session prefix hashes. For tests / session boundaries. */
export function resetCachePrefixObservation(): void {
	prefixHashBySession.clear();
}
