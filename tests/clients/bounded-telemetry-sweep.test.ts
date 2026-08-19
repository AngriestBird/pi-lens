/**
 * Registered-or-fail sweep for bounded telemetry (#1743).
 *
 * The rule this makes structural: a record written on a FAILURE path either
 * routes through `emitBounded`/`admitBounded`, or it names the reason its
 * volume is already bounded. Prose could not enforce that — four PRs in two
 * days each rebuilt the bounding by hand, and each needed a review round to
 * get it right.
 *
 * Shape follows the #1692 lessons the finding-delivery-gate sweep paid for:
 *
 * - **Call-shaped evidence.** Findings come from balanced-paren CALL sites, so
 *   a failure names a file, a line, and a callee a reader can go open.
 * - **One seam per tag.** A phase belongs to the registry or to the reasons
 *   map, never both, and the sweep asserts the exclusivity in both directions.
 * - **No stale claims.** Every reasons-map key and every registry entry must
 *   still correspond to a live call site, so a deleted or migrated phase turns
 *   the declaration red instead of leaving a lie behind.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOUNDED_TELEMETRY_PHASES } from "../../clients/bounded-telemetry.js";
import {
	type EmissionSite,
	isFailureShapedPhase,
	scanEmissionSites,
	scanSource,
	UNBOUNDED_FAILURE_PHASE_REASONS,
} from "../support/bounded-telemetry-scan.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SITES = scanEmissionSites(REPO_ROOT);
const RAW_SITES = SITES.filter((site) => site.callee === "logLatency");
const HELPER_SITES = SITES.filter((site) => site.callee !== "logLatency");

/** `file:line` for every finding, so a failure message is actionable. */
function evidence(sites: EmissionSite[]): string[] {
	return sites.map((site) => `${site.file}:${site.line} (${site.callee})`);
}

describe("bounded-telemetry sweep (#1743)", () => {
	it("scans a non-trivial population, so a broken scanner cannot pass vacuously", () => {
		// A regex typo that matched nothing would make every assertion below
		// trivially true. Pin the floor instead of the exact count, which churns.
		expect(RAW_SITES.length).toBeGreaterThan(100);
		expect(HELPER_SITES.length).toBeGreaterThanOrEqual(6);
	});

	it("every failure-path record is either helper-emitted or has a stated reason", () => {
		const unaccounted = RAW_SITES.filter(
			(site) =>
				site.phase !== undefined &&
				isFailureShapedPhase(site.phase) &&
				!(site.phase in UNBOUNDED_FAILURE_PHASE_REASONS),
		);
		expect(
			evidence(unaccounted),
			[
				"A failure-path `logLatency` is unaccounted for.",
				"Either route it through `emitBounded` (clients/bounded-telemetry.ts)",
				"and add its phase to BOUNDED_TELEMETRY_PHASES, or add the phase to",
				"UNBOUNDED_FAILURE_PHASE_REASONS with the MECHANISM that already",
				"bounds its volume.",
			].join(" "),
		).toEqual([]);
	});

	it("every stated reason is non-empty and names a mechanism", () => {
		for (const [phase, reason] of Object.entries(
			UNBOUNDED_FAILURE_PHASE_REASONS,
		)) {
			expect(
				reason.trim().length,
				`${phase} has an empty reason`,
			).toBeGreaterThan(20);
		}
	});

	it("a registered phase is never also written by a raw logLatency", () => {
		const registered = new Set<string>(BOUNDED_TELEMETRY_PHASES);
		const leaked = RAW_SITES.filter(
			(site) => site.phase !== undefined && registered.has(site.phase),
		);
		expect(
			evidence(leaked),
			"A phase in BOUNDED_TELEMETRY_PHASES is still written by a raw logLatency. One seam per phase: route it through emitBounded.",
		).toEqual([]);
	});

	it("every registered phase has a live helper call site", () => {
		const emitted = new Set(
			HELPER_SITES.map((site) => site.phase).filter(
				(phase): phase is string => phase !== undefined,
			),
		);
		const dead = BOUNDED_TELEMETRY_PHASES.filter(
			(phase) => !emitted.has(phase),
		);
		expect(
			dead,
			"A registry entry has no emitBounded/admitBounded call site. Remove it, or the registry stops describing the code.",
		).toEqual([]);
	});

	it("every stated reason still has a live raw call site", () => {
		const rawPhases = new Set(
			RAW_SITES.map((site) => site.phase).filter(
				(phase): phase is string => phase !== undefined,
			),
		);
		const stale = Object.keys(UNBOUNDED_FAILURE_PHASE_REASONS).filter(
			(phase) => !rawPhases.has(phase),
		);
		expect(
			stale,
			"A phase with a stated reason no longer has a raw logLatency site. It was migrated or deleted — drop the entry.",
		).toEqual([]);
	});

	it("the registry and the reasons map are disjoint", () => {
		const both = BOUNDED_TELEMETRY_PHASES.filter(
			(phase) => phase in UNBOUNDED_FAILURE_PHASE_REASONS,
		);
		expect(both, "A phase claims both seams; pick one.").toEqual([]);
	});
});

describe("bounded-telemetry scanner self-test", () => {
	const fixture = [
		'logLatency({ type: "phase", phase: "probe_alpha_timeout", durationMs: 1 });',
		'emitBounded("loop_block", identity, { durationMs: 2 });',
		'admitBounded("loop_block", identity, { capPerTurn: { limit: 1, turnIndex: 0 } });',
		'myLogLatency({ phase: "probe_not_a_call_timeout" });',
		"logLatency(buildEntry(kind, { nested: fn(1) }));",
	].join("\n");
	const found = scanSource(fixture, "fixture.ts");

	it("reads the phase out of each call's own arguments, with its line", () => {
		expect(found.map((site) => [site.line, site.callee, site.phase])).toEqual([
			[1, "logLatency", "probe_alpha_timeout"],
			[2, "emitBounded", "loop_block"],
			[3, "admitBounded", "loop_block"],
			[5, "logLatency", undefined],
		]);
	});

	it("does not match an identifier that merely ends in the callee name", () => {
		expect(found.some((site) => site.line === 4)).toBe(false);
	});

	it("classifies failure-shaped phase names by outcome suffix, not by topic", () => {
		expect(isFailureShapedPhase("lsp_pull_diagnostic_timeout")).toBe(true);
		expect(isFailureShapedPhase("project_snapshot_persist_failed")).toBe(true);
		expect(isFailureShapedPhase("review_graph_size_skip")).toBe(true);
		// Throughput phases: real work, bounded by the work itself.
		expect(isFailureShapedPhase("dispatch_complete")).toBe(false);
		expect(isFailureShapedPhase("graph_build")).toBe(false);
		expect(isFailureShapedPhase("memory_sample")).toBe(false);
		// A suffix must END the name, or `timeout_budget_configured` would match.
		expect(isFailureShapedPhase("lsp_timeout_budget_resolved")).toBe(false);
	});
});
