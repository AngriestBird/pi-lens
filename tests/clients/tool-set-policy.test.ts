import { beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", () => ({ logLatency }));

import {
	isFreshSessionStart,
	recordToolSetMutation,
	supportsDeferredTools,
} from "../../clients/tool-set-policy.js";

describe("tool-set cache policy", () => {
	beforeEach(() => logLatency.mockClear());

	it("classifies only startup and new as fresh logical sessions", () => {
		expect(isFreshSessionStart(undefined)).toBe(true);
		expect(isFreshSessionStart("startup")).toBe(true);
		expect(isFreshSessionStart("new")).toBe(true);
		for (const reason of ["fork", "reload", "resume"]) {
			expect(isFreshSessionStart(reason), reason).toBe(false);
		}
	});

	it("matches the host's deferred-tool capability signal", () => {
		expect(
			supportsDeferredTools({
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude-sonnet-4-5",
			}),
		).toBe(true);
		expect(
			supportsDeferredTools({
				api: "anthropic-messages",
				provider: "openrouter",
				id: "claude-sonnet-4-5",
			}),
		).toBe(false);
		expect(
			supportsDeferredTools({
				api: "openai-responses",
				compat: { supportsToolSearch: true },
			}),
		).toBe(true);
	});

	it("logs bounded mutation counts, reason, and deferral capability", () => {
		recordToolSetMutation({
			addedCount: 2,
			removedCount: 0,
			reason: "lazy_activation",
			deferralApplies: false,
		});

		expect(logLatency).toHaveBeenCalledOnce();
		expect(logLatency).toHaveBeenCalledWith({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "tool_set_mutation",
			durationMs: 0,
			metadata: {
				addedCount: 2,
				removedCount: 0,
				reason: "lazy_activation",
				deferralApplies: false,
			},
		});
	});
});
