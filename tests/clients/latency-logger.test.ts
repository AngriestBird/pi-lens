import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());

vi.mock("../../clients/env-utils.js", () => ({ isTestMode: () => false }));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import {
	_recentPhasesStorageLengthForTest,
	_setRecentPhasesForTest,
	getCurrentPhase,
	getLastLoggedPhase,
	getRecentLoggedPhases,
	logLatency,
	phaseFinished,
	phaseStarted,
	RECENT_PHASE_CAP,
	resetCurrentPhaseForSession,
} from "../../clients/latency-logger.js";

describe("latency-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
	});

	it("owns process and timestamp attribution instead of trusting caller fields", () => {
		logLatency({
			type: "phase",
			phase: "test",
			filePath: "fixture.ts",
			durationMs: 10,
			pid: -1,
			ts: "2000-01-01T00:00:00.000Z",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "test",
				pid: process.pid,
				ts: expect.not.stringContaining("2000-01-01"),
			}),
		);
	});
});

describe("getLastLoggedPhase (loop_block attribution, #1122/#1123)", () => {
	it("tracks the most recent phase entry", () => {
		logLatency({ type: "phase", phase: "graph_build", filePath: "<x>", durationMs: 5 });
		const last = getLastLoggedPhase();
		expect(last?.phase).toBe("graph_build");
		expect(last?.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
	});

	it("does not record loop_block itself as the last phase (no self-attribution)", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({ type: "phase", phase: "loop_block", filePath: "<pi-lens>", durationMs: 9000 });
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	it("does not let an availability decision win block attribution (#1467)", () => {
		logLatency({ type: "phase", phase: "knip", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "availability_decision",
			filePath: "<pi-lens>",
			durationMs: 5528,
			metadata: { tool: "knip", cause: "host-stall" },
		});
		expect(getLastLoggedPhase()?.phase).toBe("knip");
	});

	it("ignores non-phase entries", () => {
		logLatency({ type: "phase", phase: "cascade", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "runner", filePath: "a.ts", durationMs: 1, runnerId: "biome" });
		expect(getLastLoggedPhase()?.phase).toBe("cascade");
	});

	// #1412 L3: the classic-TS first-open project-identity probe is a detached,
	// best-effort telemetry sample, not genuine work — it must not win
	// lastPhase and overwrite the real stall attribution for a loop_block that
	// happens to land right after a first open.
	it("does not record lsp_typescript_project_identity as the last phase (no probe self-attribution)", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "lsp_typescript_project_identity",
			filePath: "/repo/src/app.ts",
			durationMs: 12,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	// #1458 S5: lsp_aux_wait_outcome carries a REAL wait duration (unlike its
	// zero-duration LAST_PHASE_EXCLUDED siblings above) but is still a wait-
	// OUTCOME record, not the stall itself — pin its exclusion so a future edit
	// can't drop the entry and silently start misattributing loop_block stalls
	// to this summary row.
	it("does not record lsp_aux_wait_outcome as the last phase despite its real duration", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({
			type: "phase",
			phase: "lsp_aux_wait_outcome",
			filePath: "/repo/src/app.ts",
			durationMs: 1800,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});
});

describe("getRecentLoggedPhases (#1723: bounded attribution ring)", () => {
	it("returns the most recent phases newest-first", () => {
		logLatency({ type: "phase", phase: "phase_a", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "phase", phase: "phase_b", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "phase", phase: "phase_c", filePath: "<x>", durationMs: 1 });
		const recent = getRecentLoggedPhases();
		expect(recent.map((p) => p.phase).slice(0, 3)).toEqual([
			"phase_c",
			"phase_b",
			"phase_a",
		]);
	});

	it("bounds the ring regardless of how many phases were logged (no unbounded growth)", () => {
		for (let i = 0; i < 50; i++) {
			logLatency({ type: "phase", phase: `flood_${i}`, filePath: "<x>", durationMs: 1 });
		}
		// A caller can never pull more than the cap out, even if it asks for more —
		// this is the volume bound: a jittery session cannot inflate a single
		// loop_block record's attribution payload past a fixed size.
		expect(getRecentLoggedPhases(1000).length).toBeLessThanOrEqual(5);
		expect(getRecentLoggedPhases()[0].phase).toBe("flood_49");
	});

	it("excludes the same phases as getLastLoggedPhase (loop_block, availability_decision, ...)", () => {
		logLatency({ type: "phase", phase: "real_work", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "phase", phase: "loop_block", filePath: "<pi-lens>", durationMs: 9000 });
		logLatency({
			type: "phase",
			phase: "availability_decision",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		const recent = getRecentLoggedPhases();
		expect(recent.map((p) => p.phase)).not.toContain("loop_block");
		expect(recent.map((p) => p.phase)).not.toContain("availability_decision");
		expect(recent[0].phase).toBe("real_work");
	});

	it("a caller can request fewer than the cap", () => {
		logLatency({ type: "phase", phase: "one", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "phase", phase: "two", filePath: "<x>", durationMs: 1 });
		expect(getRecentLoggedPhases(1)).toHaveLength(1);
		expect(getRecentLoggedPhases(1)[0].phase).toBe("two");
	});

	// Follow-up from review: "bounds the ring" above only observes OUTPUT
	// length through getRecentLoggedPhases, which is a compensating pair —
	// the write-side `.slice(0, RECENT_PHASE_CAP)` in logLatency and the
	// read-side `Math.min(limit, RECENT_PHASE_CAP)` clamp in
	// getRecentLoggedPhases each independently bound that output, so deleting
	// EITHER ONE ALONE still leaves the other masking it and the existing
	// test green. These two tests isolate each guard so a mutant that removes
	// either one reds on its own, not just in combination.
	it("write-side guard: storage itself never exceeds the cap, independent of the read-side clamp (#1723 review)", () => {
		for (let i = 0; i < RECENT_PHASE_CAP + 7; i++) {
			logLatency({ type: "phase", phase: `storage_flood_${i}`, filePath: "<x>", durationMs: 1 });
		}
		// Bypasses getRecentLoggedPhases (and so its read-side clamp) entirely —
		// if logLatency's `.slice(0, RECENT_PHASE_CAP)` were deleted, storage
		// would grow to RECENT_PHASE_CAP + 7 and this reds regardless of what
		// the read side does.
		expect(_recentPhasesStorageLengthForTest()).toBe(RECENT_PHASE_CAP);
	});

	it("read-side guard: an oversized limit is clamped even when storage already holds more than the cap (#1723 review)", () => {
		// Seed storage directly, past the cap, bypassing logLatency's write-side
		// slice entirely — a state the normal write path can never produce. This
		// isolates the read-side clamp: if Math.min(limit, RECENT_PHASE_CAP)
		// were deleted from getRecentLoggedPhases, requesting an oversized limit
		// against this over-capacity ring would return more than the cap.
		const overCapacity = Array.from({ length: RECENT_PHASE_CAP + 10 }, (_, i) => ({
			phase: `seed_${i}`,
			ts: new Date().toISOString(),
		}));
		_setRecentPhasesForTest(overCapacity);
		expect(getRecentLoggedPhases(1000)).toHaveLength(RECENT_PHASE_CAP);
	});
});

describe("phaseStarted/phaseFinished/getCurrentPhase (#1723 in-flight attribution)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	it("names the phase as current once started", () => {
		phaseStarted("astgrep_scan");
		expect(getCurrentPhase()?.phase).toBe("astgrep_scan");
	});

	it("clears the slot once the matching finish call fires", () => {
		const token = phaseStarted("astgrep_scan");
		phaseFinished(token);
		expect(getCurrentPhase()).toBeUndefined();
	});

	// Mutation-proof for the clearing guard itself: if `phaseFinished` were a
	// no-op (a "never-cleared slot" bug), the assertion above alone wouldn't
	// distinguish it from a broken implementation that ALSO didn't set
	// anything — this pins that a phase started BEFORE the finish call is
	// gone afterward, which only holds if the clear genuinely ran.
	it("a stale (never-cleared) slot would mis-attribute a later, unrelated block", () => {
		const token = phaseStarted("full_scan_18s");
		phaseFinished(token);
		// A second, unrelated phase starts and finishes quickly.
		const secondToken = phaseStarted("word_index_build");
		phaseFinished(secondToken);
		// If the first finish had failed to clear (or had cleared the WRONG
		// slot), getCurrentPhase() here could still read "full_scan_18s" long
		// after it ended, or nothing at all despite word_index_build's own
		// finish having already run — either way the assertion below is the
		// one a stale-slot regression breaks.
		expect(getCurrentPhase()).toBeUndefined();
	});

	// Identity-token semantics: an EARLIER phase's finish (arriving after a
	// LATER phase has already started) must not clear the later phase's
	// still-live slot. Guards the exact overlap `phaseFinished`'s doc comment
	// calls out — without token comparison, a bare "clear unconditionally"
	// finish would wipe the wrong phase.
	it("an out-of-order finish for an earlier phase does not clear a later phase's slot", () => {
		const earlierToken = phaseStarted("lsp_workspace_diagnostics_touch");
		const laterToken = phaseStarted("astgrep_scan");
		// The earlier phase's async tail resolves last and calls its own finish.
		phaseFinished(earlierToken);
		expect(getCurrentPhase()?.phase).toBe("astgrep_scan");
		phaseFinished(laterToken);
		expect(getCurrentPhase()).toBeUndefined();
	});

	it("getCurrentPhase carries startedAt for elapsed-time computation", () => {
		const before = Date.now();
		phaseStarted("full_scan_18s");
		const current = getCurrentPhase();
		expect(current?.startedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
		expect(Date.parse(current!.startedAt)).toBeGreaterThanOrEqual(before);
	});

	// #1723 session-boundary backstop (catalog: state that must re-arm at
	// session_start cannot hide behind a process-lifetime latch). Without
	// this reset, a phase abandoned by a torn-down activation would survive
	// into the next session and keep mis-attributing every loop_block there.
	it("resetCurrentPhaseForSession clears a leaked in-flight phase", () => {
		phaseStarted("full_scan_18s"); // never finished — simulates an abandoned phase
		expect(getCurrentPhase()).toBeDefined();
		resetCurrentPhaseForSession();
		expect(getCurrentPhase()).toBeUndefined();
	});
});
