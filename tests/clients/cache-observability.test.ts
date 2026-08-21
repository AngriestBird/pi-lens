import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	_resetProviderCacheTtlForTests,
	clearCachePrefixSession,
	DEFAULT_PROVIDER_CACHE_TTL_MS,
	logCacheUsage,
	observeCacheContext,
	observeCachePrefix,
	resetCachePrefixObservation,
} from "../../clients/cache-observability.js";

function assistantMessage(overrides?: Record<string, unknown>) {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-4",
		usage: {
			input: 1200,
			output: 340,
			cacheRead: 8000,
			cacheWrite: 512,
			totalTokens: 9540,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.037,
			},
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

describe("cache-observability — response-side usage (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		// #1071 keeps per-session attribution state in the same module, so a test
		// that logs usage must not leak a gap baseline into the next one.
		resetCachePrefixObservation();
	});

	it("logs one cache_usage record for an assistant message that carries usage", () => {
		logCacheUsage(assistantMessage());

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_usage",
				durationMs: 0,
				metadata: {
					provider: "anthropic",
					model: "claude-opus-4",
					cacheRead: 8000,
					cacheWrite: 512,
					input: 1200,
					output: 340,
					cost: 0.037,
					interTurnGapMs: null,
					cacheMissCause: null,
					cacheMissKind: null,
					cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
					priorCacheRead: null,
					injectedCharsSinceLastTurn: 0,
					newTranscriptCharsSinceLastTurn: 0,
					attributionCharsCapped: false,
				},
			},
		]);
	});

	it("logs nothing for an assistant message with no usage (does not throw)", () => {
		expect(() =>
			logCacheUsage(assistantMessage({ usage: undefined })),
		).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});

	it("logs nothing for a non-assistant (tool_result / user) message", () => {
		logCacheUsage({
			role: "toolResult",
			toolName: "read",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		logCacheUsage({ role: "user", content: "hi" });
		expect(latencyEntries).toHaveLength(0);
	});

	it("never throws on malformed input", () => {
		expect(() => logCacheUsage(undefined)).not.toThrow();
		expect(() => logCacheUsage(null)).not.toThrow();
		expect(() => logCacheUsage("nope")).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — context observations (#1018 follow-up)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("logs a no-injection observation with bounded structural metadata", () => {
		observeCacheContext({
			sessionId: "session-alpha",
			turnIndex: 3,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private prompt" }],
		});

		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0]).toMatchObject({
			phase: "cache_context",
			metadata: {
				version: 1,
				sessionId: "session-alpha",
				turnIndex: 3,
				injectionEnabled: false,
				injectionSources: [],
				injectedMessageCount: 0,
				injectedChars: 0,
				injectedBytes: 0,
				existingMessageCount: 1,
				resultMessageCount: 1,
				placement: "none",
			},
		});
		// #1938: the prefix/first-message pair was removed — it always reported
		// "unknown" past 64 messages. `cache_prefix_break` is the surviving
		// first-message stability signal.
		expect(latencyEntries[0].metadata).not.toHaveProperty("prefixObservation");
		expect(latencyEntries[0].metadata).not.toHaveProperty("firstMessageChange");
		expect(latencyEntries[0].metadata?.observationId).toMatch(/^ctx-/);
	});

	it.each([
		["prepend", [], [{ role: "user", content: "injected" }]],
		[
			"insert-before-final",
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "prompt" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "injected" },
				{ role: "user", content: "prompt" },
			],
		],
		[
			"append",
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
				{ role: "user", content: "injected" },
			],
		],
	] as const)(
		"records %s placement and source",
		(placement, existing, result) => {
			observeCacheContext({
				sessionId: "s",
				turnIndex: 1,
				injectionEnabled: true,
				injectionSlices: [
					{
						source: "session-guidance",
						messages: [{ role: "user", content: "injected" }],
					},
					{ source: "turn-findings", messages: [] },
					{ source: "test-findings", messages: [] },
					{ source: "agent-nudge", messages: [] },
				],
				existingMessages: existing,
				resultMessages: result,
				placement,
			});
			const metadata = latencyEntries[0].metadata;
			expect(metadata?.placement).toBe(placement);
			// Empty slices are not contributors: the derived source list names only
			// what actually produced a message (#1071).
			expect(metadata?.injectionSources).toEqual(["session-guidance"]);
			expect(metadata?.injectedMessageCount).toBe(1);
			expect(metadata?.existingMessageCount).toBe(existing.length);
			expect(metadata?.resultMessageCount).toBe(result.length);
		},
	);

	it("cache_prefix_break still distinguishes a baseline from a later first-message change (#1938: cache_context no longer echoes this)", () => {
		const first = { role: "user", content: "first" };
		const changed = { role: "user", content: "changed" };
		const baseline = observeCachePrefix([first], 0, "s");
		expect(baseline).toBe("baseline");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [first],
		});
		const actualChange = observeCachePrefix([changed], 1, "s");
		expect(actualChange).toBe("changed");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [changed],
		});

		// #1938: cache_context records no longer carry prefixObservation /
		// prefixBaseline — that pair reported "unknown" on 97% of real records.
		const observations = latencyEntries.filter(
			(entry) => entry.phase === "cache_context",
		);
		for (const observation of observations) {
			expect(observation.metadata).not.toHaveProperty("prefixObservation");
			expect(observation.metadata).not.toHaveProperty("prefixBaseline");
		}
		// The surviving signal is the provider-independent local change signal,
		// still emitted directly by observeCachePrefix.
		expect(
			latencyEntries.find(
				(entry) =>
					entry.phase === "cache_prefix_break" &&
					entry.metadata?.baseline === undefined,
			),
		).toBeDefined();
	});

	it("caps counts and hashes without writing prompt or finding contents", () => {
		const privateText = "DO_NOT_LOG_THIS_PROMPT_".repeat(20_000);
		observeCacheContext({
			sessionId: "s",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: privateText }],
				},
			],
			existingMessages: Array.from({ length: 70 }, (_, i) => ({
				role: "user",
				content: `m${i}`,
			})),
			resultMessages: [{ role: "user", content: privateText }],
			placement: "prepend",
		});

		const entry = latencyEntries[0];
		expect(entry.metadata?.injectedChars).toBe(16_384);
		expect(entry.metadata?.injectedBytes).toBeLessThanOrEqual(65_536);
		expect(entry.metadata?.injectedCountsCapped).toBe(true);
		expect(entry.metadata?.sequenceHashTruncated).toBe(true);
		expect(entry.metadata?.beforeSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.metadata?.afterSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(entry.metadata)).not.toContain(
			"DO_NOT_LOG_THIS_PROMPT",
		);
	});

	it("still reports an honest sequenceHashTruncated flag for an oversized message, without an unknown prefixObservation/firstMessageChange pair (#1938)", () => {
		const existing = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-a`,
		};
		const changedSuffix = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-b`,
		};
		observeCacheContext({
			sessionId: "s",
			turnIndex: 5,
			injectionEnabled: false,
			existingMessages: [existing],
			resultMessages: [changedSuffix],
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sequenceContentHashTruncated: true,
		});
		// The removed pair must not resurface under any name.
		expect(metadata).not.toHaveProperty("firstMessageChanged");
		expect(metadata).not.toHaveProperty("firstMessageChange");
		expect(metadata).not.toHaveProperty("firstMessageHashTruncated");
		expect(metadata).not.toHaveProperty("beforeFirstMessageHash");
		expect(metadata).not.toHaveProperty("afterFirstMessageHash");
		expect(metadata).not.toHaveProperty("prefixHashTruncated");
		expect(metadata).not.toHaveProperty("prefixContentHashTruncated");
		expect(metadata).not.toHaveProperty("prefixMessageCountTruncated");
		expect(metadata).not.toHaveProperty("beforePrefixHash");
		expect(metadata).not.toHaveProperty("afterPrefixHash");
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("prefixObservationUnknown");
		expect(metadata).not.toHaveProperty("prefixBaseline");
	});

	it("does not force prefixObservation/firstMessageChange to unknown on a 200-message transcript (#1938)", () => {
		const existingMessages = Array.from({ length: 200 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `message ${i}`,
		}));
		observeCacheContext({
			sessionId: "s",
			turnIndex: 100,
			injectionEnabled: false,
			existingMessages,
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		// Either the field reports a real value (never "unknown"), or it has been
		// removed from the record entirely — both satisfy the #1938 acceptance
		// criterion. What it must never do is silently report "unknown" just
		// because the transcript is long, which is what pre-fix code does past
		// MAX_HASHED_MESSAGES (64) messages. This repo's chosen fix removes the
		// field outright (see the module doc), so assert that directly too.
		if ("prefixObservation" in metadata) {
			expect(metadata.prefixObservation).not.toBe("unknown");
		}
		if ("firstMessageChange" in metadata) {
			expect(metadata.firstMessageChange).not.toBe("unknown");
		}
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("firstMessageChange");
	});

	it("marks a secondary context observation without a session-local turn", () => {
		observeCacheContext({
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private" }],
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sessionRole: "concurrent-secondary",
			turnScope: "unavailable-concurrent-secondary",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});

	it("adds only session/turn correlation to cache usage when the host has no request id", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "s",
			turnIndex: 4,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "s",
			turnIndex: 4,
			turnScope: "process-global-runtime",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("requestId");
	});

	it("does not present the shared process turn as a secondary session turn", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "secondary",
			turnScope: "unavailable-concurrent-secondary",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});
});

describe("cache-observability — request-side prefix stability (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	const first = { role: "user", content: "the original first user turn" };
	const changed = { role: "user", content: "a DIFFERENT first user turn" };
	const SID = "session-alpha";

	it("logs a baseline on first observation, then a break when messages[0] changes", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "ok" }],
			0,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(1);
		const baseline = latencyEntries[0];
		expect(baseline.phase).toBe("cache_prefix_break");
		expect(baseline.metadata?.baseline).toBe(true);
		expect(baseline.metadata?.previousHash).toBeNull();
		expect(baseline.metadata?.sessionId).toBe(SID);
		expect(baseline.metadata?.sessionRole).toBe("primary");
		const baselineHash = baseline.metadata?.currentHash as string;
		expect(typeof baselineHash).toBe("string");

		// messages[0] changed within the SAME session -> one break record.
		observeCachePrefix(
			[changed, { role: "assistant", content: "ok" }],
			1,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(2);
		const brk = latencyEntries[1];
		expect(brk).toMatchObject({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_prefix_break",
			durationMs: 0,
		});
		expect(brk.metadata?.turnIndex).toBe(1);
		expect(brk.metadata?.previousHash).toBe(baselineHash);
		expect(brk.metadata?.currentHash).not.toBe(baselineHash);
		expect(brk.metadata?.baseline).toBeUndefined();
		expect(brk.metadata?.sessionId).toBe(SID);
	});

	it("logs NOTHING when messages[0] is identical across calls (same session)", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 1" }],
			0,
			SID,
		);
		expect(latencyEntries).toHaveLength(1); // baseline only

		// Same messages[0] content, different later messages / turnIndex — no break.
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 2 differs" }],
			1,
			SID,
		);
		observeCachePrefix(
			[{ role: "user", content: "the original first user turn" }],
			2,
			SID,
		);
		expect(latencyEntries).toHaveLength(1);
	});

	it("does NOT log a break when a DIFFERENT session id first appears (subagent/new)", () => {
		// Parent session establishes its baseline.
		observeCachePrefix([first], 0, "session-parent", "primary");
		expect(latencyEntries).toHaveLength(1);

		// A concurrent subagent (different id) with a DIFFERENT messages[0] must NOT
		// be compared against the parent — it gets its OWN baseline, no break.
		observeCachePrefix(
			[changed],
			0,
			"session-subagent",
			"concurrent-secondary",
		);
		expect(latencyEntries).toHaveLength(2);
		const sub = latencyEntries[1];
		expect(sub.metadata?.baseline).toBe(true);
		expect(sub.metadata?.previousHash).toBeNull();
		expect(sub.metadata?.sessionId).toBe("session-subagent");
		expect(sub.metadata?.sessionRole).toBe("concurrent-secondary");
		expect(latencyEntries.some((e) => e.metadata?.baseline === undefined)).toBe(
			false,
		); // no break record emitted for either session
	});

	it("keeps two concurrent sessions' baselines independent (no cross-contamination)", () => {
		observeCachePrefix([first], 0, "sid-A", "primary");
		observeCachePrefix([changed], 0, "sid-B", "concurrent-secondary");
		latencyEntries.length = 0;

		// Each session re-observing its OWN unchanged messages[0] => no break.
		observeCachePrefix([first], 1, "sid-A", "primary");
		observeCachePrefix([changed], 1, "sid-B", "concurrent-secondary");
		expect(latencyEntries).toHaveLength(0);
	});

	it("resume: same session id across rounds keeps the baseline and catches a real break", () => {
		observeCachePrefix([first], 0, "resumed-session");
		expect(latencyEntries).toHaveLength(1); // baseline

		// Simulate resume: SAME id observes again; unchanged => still no break.
		observeCachePrefix([first], 1, "resumed-session");
		expect(latencyEntries).toHaveLength(1);

		// A genuine post-resume change to messages[0] IS caught.
		observeCachePrefix([changed], 2, "resumed-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("resumed-session");
	});

	it("clearCachePrefixSession drops one session's baseline (re-baselines on next observe)", () => {
		observeCachePrefix([first], 0, "shutdown-session");
		expect(latencyEntries).toHaveLength(1);

		clearCachePrefixSession("shutdown-session");

		// After clearing, the next observation re-logs a baseline (not a break),
		// even with a changed messages[0].
		observeCachePrefix([changed], 1, "shutdown-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBe(true);
		expect(latencyEntries[1].metadata?.previousHash).toBeNull();
	});

	it("falls back to a single bucket when no session id is given", () => {
		observeCachePrefix([first], 0);
		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0].metadata?.sessionId).toBe("<no-session>");

		// Same fallback bucket, changed messages[0] => a break (old single-var semantics).
		observeCachePrefix([changed], 1);
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("<no-session>");
	});

	it("LRU bound evicts oldest sessions past the cap without throwing", () => {
		// Cap is 32; establish 40 distinct sessions, then re-observe the OLDEST.
		for (let i = 0; i < 40; i++) {
			observeCachePrefix([{ role: "user", content: `s${i}` }], 0, `lru-${i}`);
		}
		expect(latencyEntries).toHaveLength(40); // 40 baselines
		latencyEntries.length = 0;

		// lru-0 was evicted; re-observing it re-baselines rather than diffing.
		expect(() =>
			observeCachePrefix([{ role: "user", content: "s0" }], 1, "lru-0"),
		).not.toThrow();
		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0].metadata?.baseline).toBe(true);
	});

	it("does nothing on an empty transcript and never throws", () => {
		expect(() => observeCachePrefix([], 0, SID)).not.toThrow();
		expect(() => observeCachePrefix(undefined, 0, SID)).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — miss attribution (#1071)", () => {
	const BASE_MS = 1_700_000_000_000;

	function usageMessage(cacheRead: number, input: number) {
		return assistantMessage({
			usage: { input, output: 10, cacheRead, cacheWrite: 0 },
		});
	}

	function logUsage(cacheRead: number, input: number, sessionId = "attr") {
		logCacheUsage(usageMessage(cacheRead, input), undefined, {
			sessionId,
			turnIndex: 0,
		});
	}

	function lastUsageMetadata(): Record<string, unknown> {
		const usageEntries = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		);
		return (usageEntries[usageEntries.length - 1]?.metadata ?? {}) as Record<
			string,
			unknown
		>;
	}

	/** Feed one `context` observation so the ledger sees real injected content. */
	function observeInjection(chars: number, sessionId = "attr") {
		observeCacheContext({
			sessionId,
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "x".repeat(chars) }],
				},
			],
			placement: "insert-before-final",
		});
	}

	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
		_resetProviderCacheTtlForTests();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		vi.useFakeTimers();
		vi.setSystemTime(BASE_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		_resetProviderCacheTtlForTests();
	});

	it("returns no verdict for the first record in a session", () => {
		logUsage(0, 5_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			cacheMissKind: null,
			priorCacheRead: null,
		});
	});

	it("records the inter-turn gap between consecutive message_end records", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 4_000);
		logUsage(8_100, 100);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 4_000,
			priorCacheRead: 8_000,
			cacheMissCause: null,
		});
	});

	it("attributes a zero read after a long idle gap to ttl-expired", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 166_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheMissKind: "zero-read",
			interTurnGapMs: 166_000,
			cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});
	});

	it("treats a gap exactly at the threshold as expired and one below it as not", () => {
		logUsage(8_000, 100, "boundary-at");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		logUsage(0, 9_000, "boundary-at");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});

		vi.setSystemTime(BASE_MS);
		logUsage(8_000, 100, "boundary-below");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS - 1);
		logUsage(0, 100, "boundary-below");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS - 1,
		});
	});

	it("honors the configured threshold instead of the default", () => {
		process.env.PI_LENS_PROVIDER_CACHE_TTL_MS = "1000";
		_resetProviderCacheTtlForTests();
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 2_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheTtlThresholdMs: 1_000,
		});
	});

	it("attributes a miss after a first-message change to prefix-broke", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 5_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissKind: "zero-read",
		});
	});

	it("prefers the observed prefix break over the idle-gap heuristic", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
	});

	it("re-arms the prefix-break flag after each usage record", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({ cacheMissCause: "unknown" });
	});

	it("attributes a low read with fresh input far above new content to partial-eviction", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 20_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			injectedCharsSinceLastTurn: 200,
			attributionCharsCapped: false,
		});
	});

	it("does not call it eviction when fresh input matches the new content", () => {
		logUsage(8_000, 100);
		observeInjection(8_000);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 900);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
		});
	});

	it("suppresses the eviction verdict when the char accumulators were capped", () => {
		logUsage(8_000, 100);
		observeInjection(40_000);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 900_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			attributionCharsCapped: true,
		});
	});

	it("reports no verdict for a healthy read", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(7_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: null,
			cacheMissKind: null,
		});
	});

	it("resets the per-turn char accumulators at each usage record", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 200,
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 0,
			newTranscriptCharsSinceLastTurn: 0,
		});
	});

	it("counts transcript growth between context observations", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "1234" }],
		});
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [
				{ role: "user", content: "1234" },
				{ role: "user", content: "567890" },
			],
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			newTranscriptCharsSinceLastTurn: 6,
		});
	});

	it("keeps attribution state per session", () => {
		logUsage(8_000, 100, "session-a");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000, "session-b");
		expect(lastUsageMetadata()).toMatchObject({
			sessionId: "session-b",
			interTurnGapMs: null,
			cacheMissCause: null,
		});
	});

	it("drops attribution state when a session shuts down", () => {
		logUsage(8_000, 100);
		clearCachePrefixSession("attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			priorCacheRead: null,
		});
	});
});

describe("cache-observability — per-source injection attribution (#1071)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("splits a mixed payload by contributing source", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "12345678" }],
				},
				{
					source: "agent-nudge",
					messages: [
						{ role: "user", content: "abc" },
						{ role: "user", content: "de" },
					],
				},
			],
			placement: "insert-before-final",
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionSourceBreakdown).toEqual([
			{
				source: "turn-findings",
				messageCount: 1,
				chars: 8,
				bytes: 8,
				estimatedTokens: 2,
				countsCapped: false,
			},
			{
				source: "agent-nudge",
				messageCount: 2,
				chars: 5,
				bytes: 5,
				estimatedTokens: 2,
				countsCapped: false,
			},
		]);
		expect(metadata.injectionSources).toEqual(["turn-findings", "agent-nudge"]);
		expect(metadata.injectedChars).toBe(13);
		expect(metadata.injectedEstimatedTokens).toBe(4);
		expect(metadata.injectionOccurred).toBe(true);
	});

	it("labels the token figure as an estimate, never as provider usage", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "test-findings",
					messages: [{ role: "user", content: "ab" }],
				},
			],
		});
		expect(latencyEntries[0].metadata?.injectedTokenBasis).toBe(
			"chars-per-token-4-estimate-not-provider-measured",
		);
	});

	it("reports no injection and no sources for an empty payload", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [{ source: "turn-findings", messages: [] }],
		});
		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionOccurred).toBe(false);
		expect(metadata.injectionSources).toEqual([]);
		expect(metadata.injectionSourceBreakdown).toEqual([]);
	});

	it("keeps the per-source split free of injected content", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 3,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "SECRET_FINDING_TEXT" }],
				},
			],
		});
		expect(JSON.stringify(latencyEntries[0].metadata)).not.toContain(
			"SECRET_FINDING_TEXT",
		);
	});
});
