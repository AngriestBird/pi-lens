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
	_closedBracketsStorageLengthForTest,
	_recentPhasesStorageLengthForTest,
	_setRecentPhasesForTest,
	CLOSED_BRACKET_CAP,
	getCurrentPhase,
	getLastLoggedPhase,
	getPhaseForWindow,
	getRecentLoggedPhases,
	logLatency,
	type PhaseWindowAttribution,
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

// #1723 review round (redesign of the slot mechanism, probe-proven against the
// real dispatcher): a single slot broke two ways once overlap is the NORMAL
// case (dispatchForFile runs runner groups in PARALLEL, dispatcher.ts:853),
// plus a third, decisive gap for the motivating synchronous case. This block
// rebuilds the reviewer's three probes as regression tests, all reproducible
// at the latency-logger unit level (a dispatcher-level version of F1/F2 lives
// in tests/clients/dispatch/runner-timeout.test.ts).
describe("getCurrentPhase/getPhaseForWindow: overlap and window attribution (#1723 review)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	// F1: a single slot held only the LAST starter — a cheap idle runner
	// starting after a CPU hog would win outright, naming the innocent runner
	// while the hog stayed anonymous. The Map-based live set instead surfaces
	// the OLDEST still-open bracket, which is the hog.
	it("F1: names the CPU hog, not an idle runner that started after it, while both are live", () => {
		phaseStarted("cpu-hog");
		phaseStarted("idle"); // starts AFTER the hog, while the hog is still open
		expect(getCurrentPhase()?.phase).toBe("cpu-hog");
	});

	// F2: a quick sibling that starts second but finishes FIRST used to clear
	// the single slot out from under the still-running long phase. Per-token
	// map entries mean a sibling's finish can only ever remove ITS OWN entry.
	it("F2: an idle runner finishing first does not clear the still-running long phase's bracket", () => {
		const hogToken = phaseStarted("cpu-hog");
		const idleToken = phaseStarted("idle");
		phaseFinished(idleToken); // idle finishes quickly...
		// ...but the hog is still open, and still names as current.
		expect(getCurrentPhase()?.phase).toBe("cpu-hog");
		phaseFinished(hogToken);
		expect(getCurrentPhase()).toBeUndefined();
	});

	// F3 (decisive): phaseFinished runs inside a `finally`, which resumes as a
	// MICROTASK. turn_end is scheduled as a MACROTASK. Microtasks always fully
	// drain before the next macrotask runs, so a genuinely SYNCHRONOUS phase —
	// the motivating 18s case — has ALREADY closed (and so left liveBrackets)
	// by the time anything reads it. This is the real, unmocked JS scheduling
	// order (no fake timers): the phase's own try/finally resolves entirely
	// before the setTimeout callback below ever runs.
	it("F3: a macrotask sample after a synchronous phase's microtask-scheduled finish still attributes it via window overlap", async () => {
		const blockStartMs = Date.now();
		const token = phaseStarted("full_scan_18s");
		const doSynchronousWork = async () => {
			try {
				// Real synchronous (blocking) work, kept short for test speed.
				const busyUntil = Date.now() + 30;
				while (Date.now() < busyUntil) {
					/* busy-wait, mimicking a CPU-bound scan */
				}
			} finally {
				phaseFinished(token); // exactly like runRunner's finally
			}
		};
		await doSynchronousWork();

		// By now the bracket has already closed — liveBrackets is empty. This
		// is exactly what made the old single-slot design (and getCurrentPhase
		// alone) miss the synchronous case.
		expect(getCurrentPhase()).toBeUndefined();

		// Simulate turn_end firing as a macrotask AFTER the phase's finally.
		const attribution = await new Promise<ReturnType<typeof getPhaseForWindow>>((resolve) => {
			setTimeout(() => {
				const blockEndMs = Date.now();
				resolve(getPhaseForWindow(blockStartMs, blockEndMs));
			}, 0);
		});

		expect(attribution?.phase).toBe("full_scan_18s");
		expect(attribution?.stillRunning).toBe(false);
		expect(attribution?.elapsedMs).toBeGreaterThanOrEqual(30);
	});

	// Deterministic companion to the real-scheduling F3 test above: fake
	// timers pin the exact overlap arithmetic, including that a live bracket
	// (still running, no closedAt yet) is attributed too, not just closed ones.
	it("F3b: getPhaseForWindow attributes a still-open bracket against an exact window (fake timers)", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			phaseStarted("full_scan_18s");
			vi.setSystemTime(t0 + 18_270); // block ends exactly when the probe samples
			const attribution = getPhaseForWindow(t0, t0 + 18_270);
			expect(attribution?.phase).toBe("full_scan_18s");
			expect(attribution?.stillRunning).toBe(true);
			expect(attribution?.elapsedMs).toBe(18_270);
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 3, N2: an earlier version of this test pinned a
	// dedicated `overlapMs <= 0` early-return guard that turned out to be
	// PROVABLY DEAD CODE — with `bestOverlapMs` seeded at 0 and the accept
	// condition requiring `overlapMs > bestOverlapMs` (a tie only ever refines
	// an EXISTING best), a zero-or-negative overlap can never win regardless
	// of whether that guard exists. The old test could not fail under any
	// mutation of it (catalog shape 7 — a vacuous test). The guard was
	// deleted; this test is its discriminating replacement: it pins the
	// INTRINSIC behavior (zero overlap never wins) against a genuine
	// positive-overlap INCUMBENT, so a real regression — e.g. loosening the
	// accept condition to `>=`, letting a tie silently overturn a correct
	// answer — has something to break.
	it("a bracket with exactly zero overlap against the window never overturns a genuine positive-overlap incumbent", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			const incumbentToken = phaseStarted("genuine_incumbent");
			vi.setSystemTime(t0 + 5000);
			phaseFinished(incumbentToken); // elapsedMs 5000, fully inside the window below

			// Starts exactly when the window ends (zero overlap, not negative);
			// long enough on its own to clear the N4 plausibility floor, so
			// this candidate is excluded by the OVERLAP check specifically, not
			// incidentally by the floor.
			const zeroOverlapToken = phaseStarted("zero_overlap_candidate");
			vi.setSystemTime(t0 + 5000 + 6000);
			phaseFinished(zeroOverlapToken);

			const attribution = getPhaseForWindow(t0, t0 + 5000);
			expect(attribution?.phase).toBe("genuine_incumbent");
		} finally {
			vi.useRealTimers();
		}
	});

	// Mutation-proof: ring unbounded (#1723 review, mirrors the existing
	// recentPhases write-side guard test). If phaseFinished's
	// `.slice(0, CLOSED_BRACKET_CAP)` were deleted, storage would grow past
	// the cap.
	it("mutation-proof: the closed-bracket ring never exceeds CLOSED_BRACKET_CAP", () => {
		for (let i = 0; i < CLOSED_BRACKET_CAP + 7; i++) {
			const token = phaseStarted(`closed_flood_${i}`);
			phaseFinished(token);
		}
		expect(_closedBracketsStorageLengthForTest()).toBe(CLOSED_BRACKET_CAP);
	});

	// Mutation-proof: a never-deleted live entry (phaseFinished's `Map.delete`
	// silently made a no-op) would leave a phantom bracket "open" forever,
	// permanently winning getCurrentPhase's oldest-wins tie-break over every
	// later, genuinely-running phase.
	it("mutation-proof: a correctly finished phase never lingers as the oldest open bracket", () => {
		const staleToken = phaseStarted("should_have_closed");
		phaseFinished(staleToken);
		phaseStarted("genuinely_running_now");
		expect(getCurrentPhase()?.phase).toBe("genuinely_running_now");
	});
});

// #1723 review round 3: N1 (blocker), N3, N4 — three findings against the
// round-2 redesign, each proven with a controlled fake-timer scenario so the
// exact numbers are reproducible instead of racing real wall-clock ms.
describe("getPhaseForWindow tie-break and plausibility floor (#1723 review round 3)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	// N1 (blocker) + N3: the round-2 tie-break kept "whichever candidate was
	// found first" (live brackets scanned oldest-first, i.e. Map insertion
	// order). Two brackets can tie in overlap while genuinely differing in
	// elapsedMs (a phase whose lifetime roughly IS the window, vs. one that
	// merely CONTAINS it) — insertion order is not a real signal for which is
	// the culprit, and the reviewer demonstrated that flipping which one
	// started first (equivalently: dispatcher.ts group order) flipped the
	// named culprit for an IDENTICAL scenario. This constructs the same exact
	// tie in BOTH insertion orders (via fake-timer time travel, so the two
	// brackets' `startedAt` values are identical across both runs — only
	// which `phaseStarted` call happens first differs) and asserts
	// `getPhaseForWindow` — the production read path (index.ts's `turn_end`)
	// — names the smaller-elapsedMs bracket (the real culprit) either way.
	it("N1/N3: an exact overlap tie between two live brackets is decided by elapsedMs, never by insertion order", () => {
		const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
		const hogStartMs = t0 + 1000;
		const longLivedStartMs = t0; // started well before the window
		const windowStartMs = hogStartMs;
		const windowEndMs = hogStartMs + 18_270;
		const queryNowMs = windowEndMs + 500; // both still running past the window

		const runScenario = (hogInsertedFirst: boolean): PhaseWindowAttribution | undefined => {
			resetCurrentPhaseForSession();
			vi.useFakeTimers();
			try {
				if (hogInsertedFirst) {
					vi.setSystemTime(hogStartMs);
					phaseStarted("cpu_hog");
					vi.setSystemTime(longLivedStartMs); // time-travel backward
					phaseStarted("innocent_long_lived");
				} else {
					vi.setSystemTime(longLivedStartMs);
					phaseStarted("innocent_long_lived");
					vi.setSystemTime(hogStartMs);
					phaseStarted("cpu_hog");
				}
				vi.setSystemTime(queryNowMs);
				return getPhaseForWindow(windowStartMs, windowEndMs);
			} finally {
				vi.useRealTimers();
			}
		};

		const hogFirst = runScenario(true);
		const longLivedFirst = runScenario(false);

		// Both scenarios describe the IDENTICAL tie (same overlap, 18 270ms,
		// for both brackets) — only insertion order differs. cpu_hog's own
		// elapsedMs (18 770ms: it started at the window edge) is smaller than
		// innocent_long_lived's (19 770ms: it started 1000ms earlier), so the
		// hog must win regardless of which order it was inserted in.
		expect(hogFirst?.phase).toBe("cpu_hog");
		expect(longLivedFirst?.phase).toBe("cpu_hog");
		expect(hogFirst?.elapsedMs).toBe(18_770);
		expect(longLivedFirst?.elapsedMs).toBe(18_770);
	});

	// N3: a bracket leaked by a torn-down concurrent secondary (no age/size
	// cap on `liveBrackets` itself — see `phaseFinished`'s doc comment) is old
	// by construction, so it ties in overlap with a REAL later culprit for
	// any window the leak fully contains. Confirms the N1 tie-break demotes
	// it: the real culprit's smaller elapsedMs wins even though the leaked
	// bracket has been "open" for 78 seconds.
	it("N3: a 78s leaked bracket does not beat a real, smaller-elapsedMs culprit on an overlap tie", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			phaseStarted("leaked_from_torn_down_secondary"); // never finished — the leak

			const cullStartMs = t0 + 78_000;
			vi.setSystemTime(cullStartMs);
			const culpritToken = phaseStarted("full_scan_18s");
			vi.setSystemTime(cullStartMs + 18_270);
			phaseFinished(culpritToken);

			vi.setSystemTime(cullStartMs + 18_270 + 500); // sample shortly after
			const attribution = getPhaseForWindow(cullStartMs, cullStartMs + 18_270);

			expect(attribution?.phase).toBe("full_scan_18s");
			expect(attribution?.stillRunning).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	// N4: the closed-bracket ring is bounded (`CLOSED_BRACKET_CAP`) — sibling
	// churn can evict the real culprit before `turn_end` ever samples. Without
	// a plausibility floor, whatever tiny bracket is left with SOME positive
	// overlap would be reported as a confident (and wrong) answer. This
	// evicts an 18 270ms culprit with `CLOSED_BRACKET_CAP` later closes and
	// leaves a single 2ms bracket with a genuine 2ms overlap against the
	// culprit's own window — the floor must reject it, returning `undefined`
	// (absent-but-honest) rather than naming the 2ms blip.
	it("N4: sibling churn evicting the real culprit off the ring does not produce a confident wrong answer", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			const culpritToken = phaseStarted("full_scan_18s");
			const culpritEndMs = t0 + 18_270;
			vi.setSystemTime(culpritEndMs);
			phaseFinished(culpritToken); // ring: [culprit]

			// CLOSED_BRACKET_CAP - 1 filler siblings, entirely AFTER the window
			// (zero/negative overlap on their own) — just occupy ring capacity.
			for (let i = 0; i < CLOSED_BRACKET_CAP - 1; i++) {
				const fillerToken = phaseStarted(`filler_${i}`);
				vi.setSystemTime(culpritEndMs + 100 + i);
				phaseFinished(fillerToken);
			}

			// The CAP-th close evicts the culprit. This one straddles the
			// window's tail by exactly 2ms — real, positive overlap, but far
			// too small to plausibly explain an 18 270ms block.
			vi.setSystemTime(culpritEndMs - 2);
			const tinyToken = phaseStarted("tiny_unrelated_blip");
			vi.setSystemTime(culpritEndMs);
			phaseFinished(tinyToken);

			expect(_closedBracketsStorageLengthForTest()).toBe(CLOSED_BRACKET_CAP);

			const attribution = getPhaseForWindow(t0, culpritEndMs);
			expect(attribution).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
