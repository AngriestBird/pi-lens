/**
 * #3662: a subagent that binds between the primary's replacement
 * `session_shutdown` and its successor's `session_start` must not take the
 * primary slot, and must not demote the real successor.
 *
 * The recurrence these guard: `releasePrimarySession()` (#2129 F3) leaves the
 * process with no registered primary for the whole replacement gap, so a gap
 * `startup` start classified `primary`, registered itself, and the reloaded
 * primary's own start then probed a live foreign ctx and classified
 * `concurrent-secondary` — skipping the full `handleSessionStart`.
 *
 * Everything here drives the real `decideSessionStart`/`releasePrimarySession`
 * pair that `index.ts` calls; nothing is mocked. The start and shutdown
 * reasons are pi 0.85.1's own vocabulary (`SessionStartEvent.reason` /
 * `SessionShutdownEvent.reason`, `core/extensions/types.d.ts`): every
 * replacement shutdown (`reload`, `new`, `resume`, `fork`) is followed by a
 * start carrying the same reason (`core/agent-session-runtime.js`,
 * `core/agent-session.js` `reload()`), and `startup` is only a runtime's first
 * bind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _seedProcessSingletonCellForTests } from "../../clients/process-singletons.js";
import {
	_resetSessionLifecycleForTests,
	decideSessionStart,
	getActiveSessionId,
	getSecondarySessionCount,
	releasePrimarySession,
	SUCCESSOR_PENDING_TTL_MS,
} from "../../clients/session-lifecycle.js";

const REPO = "/repo/host";
const TEMP_ROOT = "/tmp/subagent-wt";

function liveCtx(): unknown {
	return { isIdle: () => true };
}

function successorPendingReasons(): Array<{
	subject: string;
	reason: string;
}> {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "session-successor-pending",
		)?.latestReasons ?? []
	);
}

/** The primary starts, then shuts down for `reason` (pi releases it). */
function primaryShutsDown(reason: string | undefined): void {
	const first = decideSessionStart(liveCtx(), "host-session", REPO, "startup");
	expect(first.classification).toBe("primary");
	releasePrimarySession(reason);
}

describe("successor-pending gap (#3662)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	for (const root of [REPO, TEMP_ROOT]) {
		it(`a gap subagent in ${root} declines and the reloaded primary runs the full start`, () => {
			primaryShutsDown("reload");

			const gap = decideSessionStart(liveCtx(), "subagent", root, "startup");
			expect(gap.classification).toBe("concurrent-secondary");
			expect(gap.runFullSessionStart).toBe(false);
			expect(getActiveSessionId()).toBeUndefined();

			const successor = decideSessionStart(
				liveCtx(),
				"host-session",
				REPO,
				"reload",
			);
			expect(successor.classification).toBe("primary");
			expect(successor.runFullSessionStart).toBe(true);
			expect(getActiveSessionId()).toBe("host-session");
		});
	}

	for (const reason of ["new", "resume", "fork"]) {
		it(`the ${reason} successor with a new session id is primary after a gap subagent`, () => {
			primaryShutsDown(reason);
			decideSessionStart(liveCtx(), "subagent", REPO, "startup");

			const successor = decideSessionStart(
				liveCtx(),
				`${reason}-session`,
				REPO,
				reason,
			);
			expect(successor.classification).toBe("primary");
			expect(getActiveSessionId()).toBe(`${reason}-session`);
		});
	}

	it("a quit leaves nothing pending: the next startup is primary", () => {
		// #2129 F3 re-arm: without it a later root would decline forever.
		primaryShutsDown("quit");
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("later");
	});

	it("a shutdown with no reason leaves nothing pending", () => {
		primaryShutsDown(undefined);
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
	});

	it("a gap start with no reason fails safe to primary", () => {
		primaryShutsDown("reload");
		const next = decideSessionStart(liveCtx(), "host-session", REPO, undefined);
		expect(next.classification).toBe("primary");
	});

	it("the gap decline records one successor-pending degradation", () => {
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "subagent-1", REPO, "startup");
		decideSessionStart(liveCtx(), "subagent-2", TEMP_ROOT, "startup");
		expect(getSecondarySessionCount()).toBe(2);
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
		]);
	});

	it("a live-sibling decline after the successor registered is not a gap decline", () => {
		// The marker is only read while no primary is registered; a subagent
		// beside the live successor must not be reported as a gap decline.
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "host-session", REPO, "reload");
		const sibling = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
		expect(sibling.classification).toBe("concurrent-secondary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("a marker exactly as old as the bound has expired", () => {
		// Pins the bound's edge: the marker declines strictly inside the
		// window, so an off-by-one `<=` would keep declining at the bound.
		vi.useFakeTimers();
		primaryShutsDown("reload");
		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
		const atBound = decideSessionStart(liveCtx(), "at-bound", REPO, "startup");
		expect(atBound.classification).toBe("primary");
	});

	it("with the guard off a gap startup is primary, as before #3662", () => {
		// I5: PI_LENS_CONCURRENT_SESSION_GUARD=0 restores pre-guard behavior
		// for the whole guard, including the successor-pending decline.
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		try {
			primaryShutsDown("reload");
			const gap = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
			expect(gap.classification).toBe("primary");
			expect(gap.runFullSessionStart).toBe(true);
		} finally {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		}
	});

	it("a marker older than the bound expires: the late startup is primary", () => {
		// A replacement whose successor never starts (pi `reload()` with no
		// bindings, a host without `rebindSession`) must not decline every
		// later start for the process lifetime (catalog shape 17).
		vi.useFakeTimers();
		primaryShutsDown("new");

		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS - 1);
		expect(
			decideSessionStart(liveCtx(), "inside", REPO, "startup").classification,
		).toBe("concurrent-secondary");

		vi.advanceTimersByTime(2);
		const late = decideSessionStart(liveCtx(), "late", REPO, "startup");
		expect(late.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("late");
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
			"expired",
		]);
	});
});

/**
 * #3855: #3668's row 17. A subagent's own replacement in the primary's gap
 * carries a non-`startup` reason, so #3668 took it for the successor: it
 * registered, and the real successor probed its live ctx and was demoted. The
 * recurrences these guard: a gap start that is not the successor the primary's
 * shutdown named classified primary, or the named successor declined (no
 * primary at all).
 */
describe("only the named successor is primary in the gap (#3855)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	/** The primary starts, then shuts down for `reason`, naming `key`. */
	function primaryNames(
		reason: string,
		key: string | number | undefined,
	): void {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession(reason, key);
	}

	const start = (reason: string | undefined, key?: string | number) =>
		decideSessionStart(liveCtx(), `start-${String(key)}`, REPO, reason, key)
			.classification;

	for (const [reason, key] of [
		["reload", "/s/host.jsonl"],
		["reload", 7],
		["fork", "/s/fork.jsonl"],
		["new", "/s/new.jsonl"],
		["resume", "/s/resumed.jsonl"],
		["new", undefined],
	] as const) {
		it(`declines every other gap start and keeps the named ${reason} successor (${String(key)}) primary`, () => {
			primaryNames(reason, key);

			// A subagent's own replacement of each kind, with its own key or none.
			expect(start("reload", "/s/sub.jsonl")).toBe("concurrent-secondary");
			expect(start("fork", 99)).toBe("concurrent-secondary");
			expect(start("resume", "/s/sub.jsonl")).toBe("concurrent-secondary");
			if (key !== undefined)
				expect(start("new", undefined)).toBe("concurrent-secondary");
			expect(start("startup", key)).toBe("concurrent-secondary");
			expect(getActiveSessionId()).toBeUndefined();

			expect(start(reason, key)).toBe("primary");
			expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
				"not-the-successor",
				"declined",
			]);
		});
	}

	it("lets a file-less successor whose manager carries no ticket fail safe to primary", () => {
		// A host that does not hand the reloaded session its manager: the start
		// has no key. Only a ticket name admits it, and only for its own reason.
		primaryNames("reload", 7);
		expect(start("fork", undefined)).toBe("concurrent-secondary");
		expect(start("new", undefined)).toBe("concurrent-secondary");
		expect(start("reload", 8)).toBe("concurrent-secondary");
		expect(start("reload", undefined)).toBe("primary");
	});

	it("never lets a key-less start pass for a successor named by its file", () => {
		primaryNames("reload", "/s/host.jsonl");
		expect(start("reload", undefined)).toBe("concurrent-secondary");
		expect(start("reload", "/s/host.jsonl")).toBe("primary");
	});

	it("lets a start with no reason fail safe to primary in a named gap (#3662 F8)", () => {
		primaryNames("reload", "/s/host.jsonl");
		expect(start(undefined, "/s/sub.jsonl")).toBe("primary");
	});

	it("keeps #3662's rule for a marker that a build without the name rewrote", () => {
		// The older build's release rewrote the marker and left this build's
		// earlier name behind: the name is stale, so only `startup` declines.
		const now = Date.now();
		_seedProcessSingletonCellForTests(
			"session-lifecycle.primary-registration",
			{
				schema: "pi-lens.process-singletons",
				version: 1,
				value: {
					activeCtx: undefined,
					activeSessionId: undefined,
					activeRoot: undefined,
					secondarySessionCount: 0,
					successorPendingSince: now,
					successorNamed: {
						since: now - 1,
						reason: "reload",
						key: "/s/old.jsonl",
					},
				},
			},
		);
		expect(start("startup", undefined)).toBe("concurrent-secondary");
		expect(start("reload", "/s/sub.jsonl")).toBe("primary");
	});

	it("names nothing after a quit: a subagent's own reload is primary (#2129 F3)", () => {
		primaryNames("quit", undefined);
		expect(start("reload", "/s/sub.jsonl")).toBe("primary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("records no gap decline for a subagent's own reload beside a live primary", () => {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		expect(start("reload", "/s/sub.jsonl")).toBe("concurrent-secondary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("with the guard off a subagent's own reload in the gap is primary, as before #3662", () => {
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		try {
			primaryNames("reload", "/s/host.jsonl");
			expect(start("reload", "/s/sub.jsonl")).toBe("primary");
		} finally {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		}
	});
});
