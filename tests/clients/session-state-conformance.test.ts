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
 *
 * Claim 3 runs on `tests/support/sweep-kit.ts` (#1755) — the shared
 * registered-or-fail machinery, so this sweep and the six others stop
 * re-deriving the same semantics. The stripper behind claims 1 and 2 comes
 * from the same kit.
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
	clientSourceFiles,
	resetNameDefinitions,
	scanSessionStateCandidates,
	sessionStartResetNames,
	stripCommentsAndStrings,
} from "../support/session-state-scan.js";
import { auditRegistry } from "../support/sweep-kit.js";

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

	// The regex branch had no probe at all until review round R2: deleting it
	// wholesale left every other probe here green. These two cover it from both
	// sides — the lexing decision, and the branch's existence.
	it("R2: a phantom call inside a KEYWORD-position regex does not count as called", () => {
		// The reviewer's exploit. Reading the preceding CHARACTER sees the `f` of
		// `typeof`, calls this division, leaves the regex body unstripped, and the
		// wiring check accepts a call that is not there.
		const source = [
			"function handleSessionStart() {",
			"\tif (typeof /resetZizmorTokenAvailability()/) {",
			"\t\tresetDegradationLedger();",
			"\t}",
			"}",
		].join("\n");
		const calls = callsWithinFunction(source, "handleSessionStart");
		expect(calls).not.toContain("resetZizmorTokenAvailability");
		expect(calls).toContain("resetDegradationLedger");
	});

	it("R2: a regex holding an unbalanced brace cannot truncate the body", () => {
		// Reds if the regex branch is deleted: the `{` inside the character class
		// is then counted by the brace matcher, the body never closes, and the
		// call below it disappears.
		const source = [
			"function handleSessionStart() {",
			"\tconst re = /[{]/;",
			"\tresetDegradationLedger();",
			"}",
		].join("\n");
		expect(callsWithinFunction(source, "handleSessionStart")).toContain(
			"resetDegradationLedger",
		);
	});

	it("R2: a value-position regex is still lexed as a regex", () => {
		// The control for the keyword fix — narrowing regex position must not
		// swing so far that ordinary regex literals stop being recognized.
		const source = [
			"function handleSessionStart() {",
			'\tconst safe = arg.replace(/"/g, \'""\');',
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
		// One down: #1666 wired package-manager's reset into handleSessionStart,
		// this list's own test went red naming the fix, and the entry lost its
		// `gap`. That is the loop the registry exists to close.
		const gaps = SESSION_STATE_REGISTRY.filter((e) => e.gap).map((e) => e.id);
		expect(gaps).toEqual(["diagnostic-dispositions:deferredThisSession"]);
	});
});

// Migrated to `tests/support/sweep-kit.ts` (#1755). The three coverage claims
// below are now one `auditRegistry` call: registered-or-fail, exemptions that
// require a reason, and stale-exemption self-detection. Behaviour is
// unchanged; the kit also adds the emptiness floor (defect shape 10) that this
// sweep never had — a scan that stops flagging files used to report clean.
describe("session-state sweep — coverage", () => {
	const audit = () =>
		auditRegistry({
			sweepName: "session-state sweep",
			// Two floors, two distinguishable failures (#1755 review F4).
			// `minScanned` catches a dead WALK — a moved clients/ root, a bad
			// extension filter — and reports "looked at 0 source items".
			// `minFlagged` catches a dead DETECTOR: a healthy walk whose
			// container/reset regexes stopped matching. Today the walk sees
			// roughly 200 files and the detector flags 71.
			scannedCount: clientSourceFiles().length,
			minScanned: 100,
			minFlagged: 40,
			flagged: scanSessionStateCandidates().map((c) => c.file),
			registered: SESSION_STATE_REGISTRY.map((e) => e.module),
			exemptions: EXEMPT_SESSION_STATE_FILES,
			minReasonLength: 16,
			remediation:
				"Decide which it is. If the state must re-arm at session_start, " +
				"register it (and wire its reset into handleSessionStart). If it is a " +
				"host derivation, a config memo or turn-scoped working state, exempt it " +
				"with the reason.",
		});

	it("every session-state-shaped file is registered or exempted with a reason", () => {
		const { unaccounted, problems } = audit();
		if (unaccounted.length > 0) expect.fail(problems.join("\n\n"));
	});

	it("no exemption names a file the sweep no longer flags", () => {
		expect(audit().staleExemptions).toEqual([]);
	});

	it("every exemption carries a reason", () => {
		expect(audit().reasonlessExemptions).toEqual([]);
	});

	it("the sweep still flags files — an empty scan must fail, not read as clean", () => {
		const { flaggedCount, problems } = audit();
		expect(problems.filter((p) => p.includes("declared floor")), problems.join("\n")).toEqual([]);
		expect(flaggedCount).toBeGreaterThanOrEqual(40);
	});

	it("the walk itself still finds source files — a dead walk fails separately (F4)", () => {
		// Distinct from the test above: that one proves the DETECTOR matches,
		// this one proves the WALK has something to look at. A moved clients/
		// root reds here and names the walk; a broken container regex reds there
		// and names the detector.
		expect(clientSourceFiles().length).toBeGreaterThanOrEqual(100);
		expect(audit().scannedCount).toBe(clientSourceFiles().length);
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
