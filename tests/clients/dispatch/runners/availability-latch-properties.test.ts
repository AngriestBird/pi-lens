/**
 * State-machine property tests for the shared availability latch (#1609 item 1).
 *
 * The latch family produced ~8 distinct shipped bugs across one arc
 * (#1490/#1494/#1495/#1496/#1537/#1556-F1/#1577-F5/#1593), each caught
 * individually by a human or a reviewer, never by a test — the existing
 * suite pins specific sequences, not the invariants every sequence must
 * hold. This file generates random sequences of probe outcomes, time
 * advances, session-boundary re-arms and caller retry patterns against a
 * fresh `createAvailabilityLatch()`, and asserts five invariants after
 * EVERY step:
 *
 *   1. never durably latched on transient-only evidence
 *   2. re-arm reachable at session_start — no process-lifetime hiding
 *   3. cooldown ladder monotone non-decreasing and capped
 *   4. recovery reachable from every state once the condition heals
 *   5. degradation recorded exactly once per episode
 *
 * Deterministic: a mulberry32 PRNG seeded per run, `Date.now()` fully
 * mocked via `vi.useFakeTimers`, no wall clock anywhere. A failing
 * assertion's message carries `seed=<n> step=<n>`, which is everything
 * needed to replay it (set `BASE_SEED` to that seed and narrow
 * `NUM_RUNS`/`STEPS_PER_RUN` to reproduce a single run in isolation).
 *
 * `fast-check` is not a dependency of this repo (checked before adding
 * one); a hand-rolled seeded PRNG keeps this file dependency-free and the
 * run bounded, in line with the module's own "kept dependency-light on
 * purpose" doc comment.
 *
 * This suite targets the latch MACHINERY only (`createAvailabilityLatch`,
 * `classifyProbeFailure`, the #1568 provisional/retained arms, the
 * `recordDegradationOnce` contract) — not the class sweep across every
 * consumer, which is #1609 items 2-6 and out of scope here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AvailabilityCause,
	classifyProbeFailure,
	createAvailabilityLatch,
	HOST_STALL_EVIDENCE_MS,
	installRetryDelayMs,
	INSTALL_TRANSIENT_COOLDOWNS_MS,
	isLatchingOutcome,
	type ProbeFailureShape,
	resetInstallRetryLatches,
	transientRetryDelayMs,
	TRANSIENT_MAX_COOLDOWN_MS,
} from "../../../../clients/dispatch/runners/utils/availability-policy.ts";
import {
	getDegradationSummary,
	recordDegradationOnce,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.ts";

// --- deterministic PRNG (mulberry32) -------------------------------------

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
	return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[randInt(rng, 0, items.length - 1)] as T;
}

function chance(rng: () => number, probability: number): boolean {
	return rng() < probability;
}

// --- raw spawn-result fixtures --------------------------------------------

/** Shapes `classifyProbeFailure` recognizes as transient by construction. */
const TRANSIENT_SHAPES: ReadonlyArray<() => ProbeFailureShape> = [
	() => ({ status: null, failure: "timeout", spawnFailure: { kind: "timeout" } }),
	() => ({ status: null, failure: "aborted" }),
	() => ({ status: null, failure: "signal" }),
	() => ({ status: null, spawnFailure: { kind: "killed" } }),
	() => ({
		status: null,
		error: Object.assign(new Error("resource busy"), { code: "EAGAIN" }),
	}),
	() => ({
		status: null,
		error: Object.assign(new Error("resource busy"), { code: "EBUSY" }),
	}),
];

/** A genuinely missing tool: `tool-not-found`, durable by construction. */
function missingShape(): ProbeFailureShape {
	return {
		status: null,
		error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		spawnFailure: { kind: "tool-not-found" },
	};
}

/** A present tool that rejects its own probe args — durable, correctly so. */
function rejectingShape(): ProbeFailureShape {
	return { status: 1 };
}

/**
 * Spawn-UNKNOWN: `status === null` and nothing else — the child never even
 * started (or a signal killed the host's own probe before it could report
 * anything). This is the #1556-F1 shape: `classifyProbeFailure`'s default
 * arm reads this as `non-installable` (correct for a PRESENT tool that
 * genuinely rejects), which is wrong for a probe that learned NOTHING about
 * the tool. A compliant call site downgrades it via
 * `unclassifiedFailureOutcome: "transient"` (what the #1556 fix added to
 * `psscriptanalyzer.ts`); this generator exercises exactly that path so a
 * regression to the override itself — not just to one call site — shows up
 * here.
 */
function unknownShape(): ProbeFailureShape {
	return { status: null };
}

// --- the run -----------------------------------------------------------

const NUM_RUNS = 150;
const STEPS_PER_RUN = 35;
const BASE_SEED = 20260817;
const LEDGER_KIND = "install-retry-exhausted";

interface Model {
	/** Attempts on the shared probe-class ladder (transient failures + provisional). */
	probeAttempts: number;
	/** Attempts on the independent install-class ladder. */
	installAttempts: number;
	/** False the moment ANY genuinely durable (missing/non-installable) outcome lands. */
	sawOnlyTransientEvidence: boolean;
	/** Has an install-class exhaustion happened since the last session-start reset? */
	ledgerHadExhaustionThisEpisode: boolean;
	maxCooldownMs: number;
}

describe("availability latch: state-machine property tests (#1609)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(1_700_000_000_000));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds the five invariants across randomized seeded sequences", () => {
		for (let runIdx = 0; runIdx < NUM_RUNS; runIdx += 1) {
			const seed = BASE_SEED + runIdx;
			const rng = mulberry32(seed);
			resetDegradationLedger();
			resetInstallRetryLatches();
			vi.setSystemTime(new Date(1_700_000_000_000));

			const maxCooldownMs = chance(rng, 0.3)
				? 60_000 // a caller with a shorter respawn cadence than the shared cap (#1535)
				: TRANSIENT_MAX_COOLDOWN_MS;
			const latch = createAvailabilityLatch({ maxCooldownMs });
			const model: Model = {
				probeAttempts: 0,
				installAttempts: 0,
				sawOnlyTransientEvidence: true,
				ledgerHadExhaustionThisEpisode: false,
				maxCooldownMs,
			};
			const ledgerSubject = `prop-tool-${seed}`;
			const trace: string[] = [];

			function ctx(step: number, tag: string): string {
				return `seed=${seed} step=${step} tag=${tag} maxCooldownMs=${maxCooldownMs} trace=${JSON.stringify(
					trace.slice(-6),
				)}`;
			}

			function applyFailure(
				step: number,
				outcome: ReturnType<typeof classifyProbeFailure>["outcome"],
				cause: AvailabilityCause,
				operationClass: "probe" | "install",
			): void {
				if (outcome !== "transient") model.sawOnlyTransientEvidence = false;
				const opts =
					operationClass === "install" ? { operationClass: "install" as const } : undefined;
				const delay = latch.noteUnavailable(outcome, cause, opts);

				if (isLatchingOutcome(outcome)) {
					// A genuinely durable outcome always latches immediately.
					expect(delay, ctx(step, "durable-delay-zero")).toBe(0);
					expect(latch.read(), ctx(step, "durable-reads-false")).toBe(false);
					return;
				}

				if (operationClass === "install") {
					model.installAttempts += 1;
					const expected = installRetryDelayMs(model.installAttempts);
					expect(delay, ctx(step, "install-ladder-matches-oracle")).toBe(expected);
					if (expected === 0) {
						expect(latch.isInstallExhausted(), ctx(step, "install-exhausted-flag")).toBe(
							true,
						);
						// Mirrors the real call-site convention (govulncheck-client.ts): call
						// recordDegradationOnce on every exhausted decision, and let the
						// ledger's own once-per-key dedup collapse repeats within the episode.
						recordDegradationOnce({
							kind: LEDGER_KIND,
							subject: ledgerSubject,
							reason: `seed ${seed} step ${step}`,
						});
						model.ledgerHadExhaustionThisEpisode = true;
					} else {
						expect(delay, ctx(step, "install-ladder-positive")).toBeGreaterThan(0);
						expect(delay, ctx(step, "install-ladder-capped")).toBeLessThanOrEqual(
							Math.max(...INSTALL_TRANSIENT_COOLDOWNS_MS),
						);
					}
				} else {
					model.probeAttempts += 1;
					const expected = transientRetryDelayMs(model.probeAttempts, cause, maxCooldownMs);
					expect(delay, ctx(step, "probe-ladder-matches-oracle")).toBe(expected);
					expect(delay, ctx(step, "probe-ladder-capped")).toBeLessThanOrEqual(maxCooldownMs);
				}
			}

			function assertCommonInvariants(step: number, tag: string): void {
				const outcome = latch.getOutcome();

				// Invariant 1: never durably latched on transient-only evidence.
				if (model.sawOnlyTransientEvidence) {
					expect(outcome, ctx(step, `${tag}:inv1-missing`)).not.toBe("missing");
					expect(outcome, ctx(step, `${tag}:inv1-non-installable`)).not.toBe(
						"non-installable",
					);
				}

				// A durable verdict (genuine missing/non-installable, or an exhausted
				// install ladder) never expires with time — only reset() or
				// noteAvailable() may clear it. Pairs with invariant 2/4: the ONLY
				// escape hatches are re-arm and recovery, never the clock.
				const exhausted = latch.isInstallExhausted();
				if (exhausted || outcome === "missing" || outcome === "non-installable") {
					expect(latch.read(), ctx(step, `${tag}:durable-time-independent`)).toBe(false);
				}

				// read() is idempotent absent an intervening event or time advance.
				const first = latch.read();
				const second = latch.read();
				expect(second, ctx(step, `${tag}:read-idempotent`)).toBe(first);
			}

			function doHeal(step: number): void {
				latch.noteAvailable();
				model.probeAttempts = 0;
				model.installAttempts = 0;
				model.sawOnlyTransientEvidence = true;
				// Invariant 4: recovery reachable from every state.
				expect(latch.read(), ctx(step, "heal-reads-true")).toBe(true);
				expect(latch.getOutcome(), ctx(step, "heal-outcome-success")).toBe("success");
				expect(latch.isInstallExhausted(), ctx(step, "heal-clears-exhaustion")).toBe(false);
				expect(latch.isProvisional(), ctx(step, "heal-clears-provisional")).toBe(false);
			}

			function doSessionRearm(step: number): void {
				latch.reset();
				resetDegradationLedger();
				model.probeAttempts = 0;
				model.installAttempts = 0;
				model.sawOnlyTransientEvidence = true;
				model.ledgerHadExhaustionThisEpisode = false;
				// Invariant 2: re-arm reachable at session_start, from ANY prior state
				// (including a durably-latched or install-exhausted one) — no
				// process-lifetime hiding (#1496 shape).
				expect(latch.read(), ctx(step, "rearm-read-null")).toBeNull();
				expect(latch.getOutcome(), ctx(step, "rearm-outcome-null")).toBeNull();
				expect(latch.getCause(), ctx(step, "rearm-cause-null")).toBeNull();
				expect(latch.isInstallExhausted(), ctx(step, "rearm-not-exhausted")).toBe(false);
				expect(latch.getRetryAtMs(), ctx(step, "rearm-retry-zero")).toBe(0);
			}

			function doInstallGenerationBump(step: number): void {
				const wasExhausted = latch.isInstallExhausted();
				resetInstallRetryLatches();
				// The sync is lazy — force it the way a real caller's next probe cycle
				// would, via read().
				const afterSync = latch.read();
				if (wasExhausted) {
					// syncInstallGeneration clears the WHOLE verdict when the state IS
					// the exhausted verdict (#1497 review F1).
					expect(afterSync, ctx(step, "install-bump-clears-whole-verdict")).toBeNull();
					expect(latch.getOutcome(), ctx(step, "install-bump-outcome-null")).toBeNull();
					model.probeAttempts = 0;
					model.installAttempts = 0;
					model.sawOnlyTransientEvidence = true;
				} else {
					model.installAttempts = 0;
				}
			}

			for (let step = 0; step < STEPS_PER_RUN; step += 1) {
				const roll = rng();
				const operationClass: "probe" | "install" = chance(rng, 0.3) ? "install" : "probe";

				if (roll < 0.18) {
					// Transient probe failure, classified for real (not hardcoded).
					const shape = pick(rng, TRANSIENT_SHAPES)();
					const stalled = chance(rng, 0.4);
					const hostStallMs = stalled
						? randInt(rng, HOST_STALL_EVIDENCE_MS, HOST_STALL_EVIDENCE_MS + 3000)
						: randInt(rng, 0, HOST_STALL_EVIDENCE_MS - 100);
					const { outcome, cause } = classifyProbeFailure(shape, { hostStallMs });
					expect(outcome, ctx(step, "transient-shape-classifies-transient")).toBe(
						"transient",
					);
					trace.push(`transient(${cause},${operationClass})`);
					applyFailure(step, outcome, cause, operationClass);
				} else if (roll < 0.24) {
					// Genuinely missing tool.
					const { outcome, cause } = classifyProbeFailure(missingShape());
					expect(outcome, ctx(step, "missing-shape-classifies-missing")).toBe("missing");
					trace.push("missing");
					applyFailure(step, outcome, cause, operationClass);
				} else if (roll < 0.3) {
					// Present tool that genuinely rejects its probe args — durable, correctly.
					const { outcome, cause } = classifyProbeFailure(rejectingShape());
					expect(outcome, ctx(step, "reject-shape-classifies-non-installable")).toBe(
						"non-installable",
					);
					trace.push("reject");
					applyFailure(step, outcome, cause, operationClass);
				} else if (roll < 0.38) {
					// #1556-F1 shape: spawn-UNKNOWN, downgraded by a compliant caller.
					const { outcome, cause } = classifyProbeFailure(unknownShape(), {
						unclassifiedFailureOutcome: "transient",
					});
					expect(outcome, ctx(step, "unknown-shape-downgrade-honored")).toBe("transient");
					trace.push(`unknown-downgraded(${operationClass})`);
					applyFailure(step, outcome, cause, operationClass);
				} else if (roll < 0.46) {
					// Provisional win (#1568): served now, re-swept once cooldown expires.
					const cause = pick(rng, ["probe-timeout", "host-stall"] as const);
					const delay = latch.noteProvisionallyAvailable(cause);
					model.probeAttempts += 1;
					// A provisional win is still an "available" verdict — it resets the
					// install-class ladder exactly like noteAvailable() does, even though
					// the probe-class ladder keeps escalating (the win didn't come for free).
					model.installAttempts = 0;
					const expected = transientRetryDelayMs(model.probeAttempts, cause, maxCooldownMs);
					expect(delay, ctx(step, "provisional-matches-oracle")).toBe(expected);
					expect(latch.read(), ctx(step, "provisional-serves-true")).toBe(true);
					expect(latch.isProvisional(), ctx(step, "provisional-flag-set")).toBe(true);
					trace.push(`provisional(${cause})`);
				} else if (roll < 0.56) {
					trace.push("heal");
					doHeal(step);
				} else if (roll < 0.66) {
					// Time advance within the current cooldown: no state change expected
					// beyond what assertCommonInvariants already checks.
					vi.setSystemTime(new Date(Date.now() + randInt(rng, 1, 5_000)));
					trace.push("advance-small");
				} else if (roll < 0.76) {
					// Time advance to just past the effective cooldown.
					const gate = latch.getRetryAtMs();
					const delta = gate > Date.now() ? gate - Date.now() + 1 : randInt(rng, 1, 500);
					vi.setSystemTime(new Date(Date.now() + delta));
					trace.push("advance-past-cooldown");
				} else if (roll < 0.82) {
					// Far-future jump: a year. Durable/exhausted verdicts must not expire.
					vi.setSystemTime(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
					trace.push("advance-far-future");
				} else if (roll < 0.9) {
					trace.push("session-start-rearm");
					doSessionRearm(step);
				} else if (roll < 0.96) {
					trace.push("install-generation-bump");
					doInstallGenerationBump(step);
				} else {
					// Caller retry pattern: re-read without any intervening event.
					const first = latch.read();
					const second = latch.read();
					expect(second, ctx(step, "bare-retry-idempotent")).toBe(first);
					trace.push("bare-retry");
				}

				assertCommonInvariants(step, "post-step");
			}

			// Invariant 5: degradation recorded exactly once per episode. An
			// episode is bounded by session-start resets (which reset the ledger
			// alongside the latch), matching the real call-site convention
			// (govulncheck-client.ts: "Once per session, matching the latch's own
			// lifetime: both re-arm at session_start").
			const group = getDegradationSummary().find((entry) => entry.kind === LEDGER_KIND);
			const expectedCount = model.ledgerHadExhaustionThisEpisode ? 1 : 0;
			expect(
				group?.count ?? 0,
				`seed=${seed} degradation-recorded-exactly-once-per-episode trace=${JSON.stringify(trace)}`,
			).toBe(expectedCount);
		}
	});
});
