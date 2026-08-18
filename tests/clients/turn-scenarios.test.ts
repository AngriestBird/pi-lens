/**
 * The turn-simulation harness's seed scenarios — #1635 item 1.
 *
 * Four dogfood incidents from 2026-08-18, each replayed as a scripted turn
 * sequence against `handleTurnEnd`, asserting what the AGENT SEES.
 *
 * ## Why some of these are skipped
 *
 * A scenario asserts the CORRECT behavior, always. When the fix for that
 * incident is not on master yet, the scenario carries `pendingOn` and is
 * skipped. It is never rewritten to assert the buggy behavior — a suite that
 * encodes today's bug as today's expectation defends the bug, and the fix then
 * arrives looking like a regression.
 *
 * That also makes the redness proof trivial and honest for the pending ones:
 * delete the `pendingOn` line, run the file, and the scenario fails on current
 * master because the defect is still there. See the PR body for the captured
 * output of each.
 */

import { describe, expect, it } from "vitest";
import {
	defineTurnScenario,
	runTurnScenario,
	type TurnScenario,
} from "../support/turn-harness.js";

// ── Scenario 1 — gitleaks stale replay (#1622, fixed by PR #1627) ────────────

const gitleaksStaleReplay = defineTurnScenario({
	id: "gitleaks-stale-replay",
	incident:
		"gitleaks flagged src:397, the agent edited that file, and the STOP blocker kept citing 397 for the rest of the 30-minute TTL",
	issue: "#1622",
	async run(h) {
		h.write("src/config.ts", "const key = 'AKIA0000000000000000';\n");
		h.advance(1_000);
		h.edit("src/app.ts", "export const app = 1;\n");
		h.scan("gitleaks", {
			findings: [
				{
					ruleId: "aws-access-token",
					file: h.pathOf("src/config.ts"),
					startLine: 397,
					description: "AWS key",
				},
			],
		});

		// Turn 1: nothing has moved since the scan, so the credential is a
		// full-severity blocker with its coordinate intact.
		const first = await h.turnEnd();
		expect(first.blockers.join("\n")).toContain("hardcoded secrets detected");
		expect(first.text).toContain("src/config.ts:397");

		// Turn 2: the agent edits the cited file. The line number is now a claim
		// about a file revision that no longer exists.
		h.advance(5_000);
		h.edit("src/config.ts", "const key = process.env.AWS_KEY;\n");
		const second = await h.turnEnd();

		// Demoted, not dropped: an edit must never mute a real credential.
		expect(second.blockers.join("\n")).not.toContain(
			"hardcoded secrets detected",
		);
		expect(second.actionNeeded.join("\n")).toContain("src/config.ts");
		expect(second.text).not.toContain(":397");
	},
});

// ── Scenario 2 — knip stale cache (#1630, PR #1637 open) ─────────────────────

const knipStaleCache = defineTurnScenario({
	id: "knip-stale-unused-export",
	incident:
		"pi-lens warned that assertSafeForCmdShell was unused while a test in the same tree imported it; a direct knip run returned 0 hits",
	issue: "#1630",
	pendingOn:
		"#1630 / PR #1637 — knip's own incremental cache still serves a verdict computed before the consumer existed",
	async run(h) {
		// The symbol's declaring file. knip's cached analysis was computed here,
		// while nothing imported it.
		h.edit("src/cmd.ts", "export function assertSafeForCmdShell() {}\n");

		// A consumer appears AFTER that analysis. The declaring file's mtime does
		// not move — which is exactly why #1622's per-cited-path freshness gate
		// cannot see this: "unused export" is a whole-graph property.
		h.advance(10_000);
		h.write(
			"tests/cmd.test.ts",
			"import { assertSafeForCmdShell } from '../src/cmd.js';\nassertSafeForCmdShell();\n",
		);

		// The next turn re-runs knip, which serves its stale cached verdict.
		h.advance(1_000);
		h.edit("src/cmd.ts", "export function assertSafeForCmdShell() {\n\treturn 1;\n}\n");
		h.knip({
			issues: [
				{
					type: "export",
					file: h.pathOf("src/cmd.ts"),
					name: "assertSafeForCmdShell",
					line: 1,
				},
				// biome-ignore lint/suspicious/noExplicitAny: scenario states only
				// the issue fields the render path reads.
			] as any,
		});
		const view = await h.turnEnd();

		// The agent must not be told a symbol is unused when the current source
		// tree contains an importer of it.
		expect(view.text).not.toContain("assertSafeForCmdShell");
	},
});

// ── Scenario 3 — dependency-drift replay (#1631, PR #1633 open) ──────────────

const dependencyDriftReplay = defineTurnScenario({
	id: "dependency-drift-replay",
	incident:
		"a blocker on the consumer file replayed for 50 minutes after the missing export was added to its dependency by a bash script",
	issue: "#1631",
	pendingOn:
		"#1631 / PR #1633 — cached cross-file blockers are not revalidated against out-of-band dependency changes",
	async run(h) {
		h.write("src/worktree.ts", "export const other = 1;\n");
		h.edit(
			"tests/git-env.test.ts",
			"import { gitEnv } from '../src/worktree.js';\ngitEnv();\n",
		);
		h.blocker(
			"tests/git-env.test.ts",
			"TS2305: Module '\"../src/worktree\"' has no exported member 'gitEnv'.",
		);

		// Turn 1: the blocker is true at this instant.
		const first = await h.turnEnd();
		expect(first.blockers.join("\n")).toContain("gitEnv");

		// The export lands via a bash script — the dependency file is never
		// dispatched, so no existing invalidation event can fire.
		h.advance(17_000);
		h.write(
			"src/worktree.ts",
			"export const other = 1;\nexport function gitEnv() {}\n",
		);

		// Turn 2: an unrelated edit ends the turn.
		h.advance(1_000);
		h.edit("src/unrelated.ts", "export const x = 1;\n");
		const second = await h.turnEnd();

		// The consumer's cached verdict is a claim about its import closure. That
		// closure changed, so the verdict must be revalidated or demoted — never
		// re-served verbatim as a STOP-tier blocker.
		expect(second.blockers.join("\n")).not.toContain(
			"has no exported member 'gitEnv'",
		);
	},
});

// ── Scenario 4 — advisory-provenance file-set blind spot ─────────────────────

const provenanceFileSetBlindSpot = defineTurnScenario({
	id: "advisory-provenance-file-set",
	incident:
		"a whole-graph advisory kept validating as \"current\" because provenance only captured the declaring file, never the consumer set whose change made the claim false",
	issue: "#1630 (analysis section); no fix issue of its own yet",
	pendingOn:
		"unfixed — provenance validates only the captured file set, so a change outside it cannot be seen",
	async run(h) {
		h.edit("src/cmd.ts", "export function assertSafeForCmdShell() {}\n");

		// The advisory is "assertSafeForCmdShell is unused" — a claim about every
		// file in the project. Provenance captures the declaring file alone.
		const verdict = h.provenanceStatus([{ relative: "src/cmd.ts" }], () => {
			h.advance(10_000);
			h.write(
				"tests/cmd.test.ts",
				"import { assertSafeForCmdShell } from '../src/cmd.js';\n",
			);
		});

		// A file the claim depends on changed. "current" is a false statement of
		// freshness, not a true one about the captured set.
		expect(verdict.status).not.toBe("current");
	},
});

/** Every seed scenario, in incident order. */
export const SEED_SCENARIOS: TurnScenario[] = [
	gitleaksStaleReplay,
	knipStaleCache,
	dependencyDriftReplay,
	provenanceFileSetBlindSpot,
];

describe("turn-simulation harness seed scenarios (#1635 item 1)", () => {
	for (const scenario of SEED_SCENARIOS) {
		const title = `${scenario.id} (${scenario.issue}) — ${scenario.incident}`;
		if (scenario.pendingOn) {
			it.skip(`${title} [pending: ${scenario.pendingOn}]`, async () => {
				await runTurnScenario(scenario);
			});
			continue;
		}
		it(title, async () => {
			await runTurnScenario(scenario);
		}, 30_000);
	}

	// The skip list is the honest part of this file, so it is itself asserted:
	// a scenario is either live or carries a reason naming what blocks it.
	it("every pending scenario names what blocks it", () => {
		for (const scenario of SEED_SCENARIOS) {
			if (!scenario.pendingOn) continue;
			expect(scenario.pendingOn.length).toBeGreaterThan(20);
			expect(scenario.pendingOn).toMatch(/#\d+|unfixed/);
		}
	});

	it("seeds all four 2026-08-18 incidents", () => {
		expect(SEED_SCENARIOS.map((s) => s.id)).toEqual([
			"gitleaks-stale-replay",
			"knip-stale-unused-export",
			"dependency-drift-replay",
			"advisory-provenance-file-set",
		]);
	});
});
