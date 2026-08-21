/**
 * Unit tests for the central stale-ctx guard (#1925).
 *
 * `tests/index-wiring.test.ts` proves the wrapper is APPLIED to each real
 * `pi.on` registration. This file proves the wrapper's own policy, including
 * the two branches an end-to-end probe cannot tell apart: short-circuiting
 * BEFORE dispatch, and classifying a stale throw that races in mid-handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	isStaleExtensionCtxError,
	wrapSessionEventHandler,
} from "../../clients/session-event-guard.js";
import { makeStaleCtx, STALE_CTX_MESSAGE } from "../support/pi-mock.js";

/** A live ctx: `isIdle()` answers instead of throwing, so the probe says true. */
function liveCtx(): unknown {
	return { isIdle: () => true, cwd: process.cwd() };
}

function staleGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "extension-ctx-stale",
	);
}

describe("wrapSessionEventHandler (#1925)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});

	it("never dispatches to the handler when the ctx probes stale", async () => {
		const handler = vi.fn();
		const guarded = wrapSessionEventHandler("turn_end", handler);

		await guarded({} as never, makeStaleCtx() as never);

		// The point of probing BEFORE dispatch: the handler's first ctx read is
		// not the detector. Catching the throw afterwards would also keep the
		// host safe, but only after running whatever the handler does first.
		expect(handler).not.toHaveBeenCalled();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("pre-dispatch");
	});

	it("dispatches on a live ctx and returns the handler's own result", async () => {
		const guarded = wrapSessionEventHandler(
			"turn_start",
			(_event: never, _ctx: never) => "handled",
		);

		expect(guarded({} as never, liveCtx() as never)).toBe("handled");
		expect(staleGroup()).toBeUndefined();
	});

	it("dispatches when the probe is INCONCLUSIVE rather than assuming stale", async () => {
		// No ctx at all, and a ctx of an unexpected shape, both probe
		// `undefined`. Guessing "dead" there would silently disable pi-lens on
		// any host whose ctx does not expose `isIdle`.
		const handler = vi.fn();
		const guarded = wrapSessionEventHandler("agent_end", handler);

		guarded({} as never, undefined as never);
		guarded({} as never, { cwd: "/repo" } as never);

		expect(handler).toHaveBeenCalledTimes(2);
		expect(staleGroup()).toBeUndefined();
	});

	it("classifies a stale throw that races in after the probe (sync)", () => {
		const guarded = wrapSessionEventHandler(
			"tool_result",
			(_event: never, _ctx: never) => {
				throw new Error(STALE_CTX_MESSAGE);
			},
		);

		expect(() => guarded({} as never, liveCtx() as never)).not.toThrow();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("classifies a stale rejection that races in after the probe (async)", async () => {
		const guarded = wrapSessionEventHandler(
			"agent_settled",
			async (_event: never, _ctx: never) => {
				throw new Error(STALE_CTX_MESSAGE);
			},
		);

		await expect(
			guarded({} as never, liveCtx() as never),
		).resolves.toBeUndefined();
		expect(staleGroup()?.latestReasons[0]?.reason).toContain("mid-handler");
	});

	it("lets a NON-stale failure through, sync and async, and counts nothing", async () => {
		const syncGuarded = wrapSessionEventHandler(
			"turn_end",
			(_event: never, _ctx: never) => {
				throw new Error("boom");
			},
		);
		const asyncGuarded = wrapSessionEventHandler(
			"turn_end",
			async (_event: never, _ctx: never) => {
				throw new Error("boom");
			},
		);

		expect(() => syncGuarded({} as never, liveCtx() as never)).toThrow("boom");
		await expect(asyncGuarded({} as never, liveCtx() as never)).rejects.toThrow(
			"boom",
		);
		expect(staleGroup()).toBeUndefined();
	});

	it("keeps the event name as the ledger subject, and counts every skip", async () => {
		const turnEnd = wrapSessionEventHandler("turn_end", vi.fn());
		const toolResult = wrapSessionEventHandler("tool_result", vi.fn());

		turnEnd({} as never, makeStaleCtx() as never);
		turnEnd({} as never, makeStaleCtx() as never);
		toolResult({} as never, makeStaleCtx() as never);

		// Three skips, two subjects: aggregation must still answer WHICH handler
		// is being skipped after the detailed records stop.
		expect(staleGroup()?.count).toBe(3);
		expect(
			staleGroup()
				?.latestReasons.map((entry) => entry.subject)
				.sort(),
		).toEqual(["tool_result", "turn_end"]);
	});

	it("never lets a broken debug sink decide whether the event is handled", () => {
		const guarded = wrapSessionEventHandler("turn_start", vi.fn(), {
			dbg: () => {
				throw new Error("sink is broken");
			},
		});

		expect(() => guarded({} as never, makeStaleCtx() as never)).not.toThrow();
		expect(staleGroup()?.count).toBe(1);
	});
});

describe("isStaleExtensionCtxError (#1925)", () => {
	it("matches the SDK's message and nothing else", () => {
		expect(isStaleExtensionCtxError(new Error(STALE_CTX_MESSAGE))).toBe(true);
		expect(isStaleExtensionCtxError(new Error("some other failure"))).toBe(
			false,
		);
		expect(isStaleExtensionCtxError(STALE_CTX_MESSAGE)).toBe(false);
		expect(isStaleExtensionCtxError(undefined)).toBe(false);
	});
});
