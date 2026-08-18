/**
 * Session-state lifecycle conformance and sweep — #1635 item 2.
 *
 * Three claims, checked three different ways:
 *
 * 1. **Re-arm.** Where a probe exists, arm the state and prove the registered
 *    reset disarms it. This is the only check that touches real state.
 * 2. **Wiring.** Every `session_start` entry's reset must be reachable from
 *    `handleSessionStart` — derived from the source, not from a list anyone
 *    maintains. A reset that exists but is never called is the exact shape of
 *    #1266, #1490, #1497, #1535, #1537 and #1625.
 * 3. **Coverage.** Every file the sweep flags as session-state-shaped is
 *    registered or exempted with a reason.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	EXEMPT_SESSION_STATE_FILES,
	SESSION_STATE_REGISTRY,
	_resetRegistryProbeState,
} from "../support/session-state-registry.js";
import {
	SWEEP_HEURISTIC_LIMITS,
	callsWithinFunction,
	resetNameDefinitions,
	scanSessionStateCandidates,
	sessionStartResetNames,
	stripCommentsAndStrings,
} from "../support/session-state-scan.js";

afterEach(() => _resetRegistryProbeState());

describe("session-state registry — shape", () => {
	it("every entry is uniquely identified", () => {
		const ids = SESSION_STATE_REGISTRY.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every entry states a reason", () => {
		for (const entry of SESSION_STATE_REGISTRY) {
			expect(entry.reason.length, `${entry.id} needs a real reason`).toBeGreaterThan(
				30,
			);
		}
	});

	it("every registered reset name resolves to exactly one clients/ module", () => {
		const definitions = resetNameDefinitions();
		for (const entry of SESSION_STATE_REGISTRY) {
			const files = definitions.get(entry.resetName);
			expect(files, `${entry.id}: no exported ${entry.resetName}`).toBeDefined();
			// A duplicated reset name would make the reachability walk below
			// ambiguous — it resolves by name, so two definitions is a real hazard.
			expect(files, `${entry.id}: ${entry.resetName} is defined twice`).toHaveLength(
				1,
			);
		}
	});
});

describe("session-state registry — re-arm conformance", () => {
	const probed = SESSION_STATE_REGISTRY.filter((e) => e.probe);

	it("exercises a probe for the core session latches", () => {
		// Not every entry can be probed without spawning a real tool. This pins a
		// floor so the probe set cannot quietly drain to zero while the registry
		// grows.
		expect(probed.length).toBeGreaterThanOrEqual(5);
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.probe) continue;
		it(`${entry.id} re-arms when ${entry.resetName} runs`, () => {
			const probe = entry.probe as NonNullable<typeof entry.probe>;
			probe.reset();
			expect(probe.isArmed(), `${entry.id} should start armed`).toBe(true);
			probe.arm();
			expect(probe.isArmed(), `${entry.id} arm() did not dirty the state`).toBe(
				false,
			);
			probe.reset();
			expect(probe.isArmed(), `${entry.id} did not re-arm`).toBe(true);
		});
	}
});

// The reachability walk's own correctness, pinned against synthetic source so
// a regression here cannot hide behind whatever happens to be in clients/
// today. Review round R1 (S1) got a fabricated bug past the whole suite by
// swapping a real reset call for a COMMENT naming it: the walk regexed raw
// source, so 37/37 stayed green while the reset was gone. The narrative
// comments in runtime-session.ts's reset block name resets by hand, so this
// was armed on real source, not hypothetical.
describe("session-state scan — walker smuggle probes (R1/S1)", () => {
	const withComment = [
		"function handleSessionStart() {",
		"\t// resetZizmorTokenAvailability(); — #1535 says this belongs here",
		"\tresetDegradationLedger();",
		"}",
	].join("\n");

	it("a reset named only in a comment does not count as called", () => {
		const calls = callsWithinFunction(withComment, "handleSessionStart");
		expect(calls).toContain("resetDegradationLedger");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
	});

	it("a reset named only inside a string literal does not count as called", () => {
		const source = [
			"function handleSessionStart() {",
			'\tdbg("calling resetZizmorTokenAvailability() next");',
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).not.toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("the real call is still found when both forms are present", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// resetZizmorTokenAvailability() — see #1535",
			"\tresetZizmorTokenAvailability();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("a brace inside a comment or string cannot end the body early", () => {
		const source = [
			"function handleSessionStart() {",
			"\t// a stray } in a comment",
			'\tconst s = "another } here";',
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("stripping preserves length and line structure", () => {
		const source = 'const a = 1; // note\nconst b = "text";\n';
		const stripped = stripCommentsAndStrings(source);
		expect(stripped).toHaveLength(source.length);
		expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
		expect(stripped).toContain("const a = 1;");
		expect(stripped).not.toContain("note");
		expect(stripped).not.toContain("text");
	});
});

describe("session-state registry — session_start wiring", () => {
	const wired = sessionStartResetNames();

	it("derives a non-trivial reset chain from handleSessionStart", () => {
		// A silent derivation failure (renamed entry point, broken brace match)
		// would make every wiring assertion below vacuously... fail, but this
		// names the cause directly instead of scattering it across 20 tests.
		expect(wired.size).toBeGreaterThan(15);
		expect(wired.has("resetDegradationLedger")).toBe(true);
	});

	for (const entry of SESSION_STATE_REGISTRY) {
		if (entry.policy !== "session_start" || entry.gap) continue;
		it(`${entry.id}: ${entry.resetName} runs at session_start`, () => {
			expect(
				wired.has(entry.resetName),
				`${entry.resetName} is not reachable from handleSessionStart. ` +
					"Either wire it in, or change the entry's policy and say why.",
			).toBe(true);
		});
	}

	// The mirror image, and the more valuable half: a declared gap must still
	// BE a gap. When #1625 wires the disposition reset in, this test fails and
	// forces the registry to stop claiming it is broken.
	for (const entry of SESSION_STATE_REGISTRY) {
		if (!entry.gap) continue;
		it(`${entry.id}: the declared gap is still real`, () => {
			expect(entry.gap && entry.gap.length).toBeGreaterThan(40);
			expect(
				wired.has(entry.resetName),
				`${entry.resetName} IS wired at session_start now — delete this entry's ` +
					"`gap` field; the registry must not keep claiming a fixed bug.",
			).toBe(false);
		});
	}

	it("records the gaps this registry currently declares", () => {
		// A named inventory, so a reviewer sees the open population at a glance
		// rather than grepping for `gap:`. Shrinking it is the point of the
		// registry; growing it silently is what this asserts against.
		const gaps = SESSION_STATE_REGISTRY.filter((e) => e.gap).map((e) => e.id);
		expect(gaps).toEqual([
			"diagnostic-dispositions:deferredThisSession",
			"package-manager:availabilityLatches",
		]);
	});
});

describe("session-state sweep — coverage", () => {
	it("every session-state-shaped file is registered or exempted with a reason", () => {
		const registered = new Set(SESSION_STATE_REGISTRY.map((e) => e.module));
		const unaccounted = scanSessionStateCandidates()
			.map((c) => c.file)
			.filter(
				(file) =>
					!registered.has(file) && !(file in EXEMPT_SESSION_STATE_FILES),
			);

		if (unaccounted.length > 0) {
			expect.fail(
				`${unaccounted.length} file(s) hold module-level Map/Set state paired with a ` +
					"reset seam, but are neither in SESSION_STATE_REGISTRY nor in " +
					"EXEMPT_SESSION_STATE_FILES:\n" +
					unaccounted.map((f) => `  ${f}`).join("\n") +
					"\n\nDecide which it is. If the state must re-arm at session_start, " +
					"register it (and wire its reset into handleSessionStart). If it is a " +
					"host derivation, a config memo or turn-scoped working state, exempt it " +
					"with the reason.",
			);
		}
	});

	it("no exemption names a file the sweep no longer flags", () => {
		const scanned = new Set(scanSessionStateCandidates().map((c) => c.file));
		const stale = Object.keys(EXEMPT_SESSION_STATE_FILES).filter(
			(file) => !scanned.has(file),
		);
		expect(stale).toEqual([]);
	});

	it("every exemption carries a reason", () => {
		for (const [file, reason] of Object.entries(EXEMPT_SESSION_STATE_FILES)) {
			expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(15);
		}
	});

	it("documents the heuristic's blind spots rather than claiming full coverage", () => {
		// The sweep is a floor. This asserts that the boundary stays written
		// down: a future edit that deletes the limits list has to notice it is
		// deleting the honesty, not just a comment.
		expect(SWEEP_HEURISTIC_LIMITS.length).toBeGreaterThanOrEqual(5);
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("closure");
		expect(SWEEP_HEURISTIC_LIMITS.join(" ")).toContain("no reset seam");
	});
});
