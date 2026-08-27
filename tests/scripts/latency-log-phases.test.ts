/**
 * Tests for scripts/lib/latency-log-phases.mjs — the pure NDJSON phase
 * parsing/filtering used by scripts/compat-smoke-behavioral.mjs (#476, Layer B)
 * to assert phases logged (or absent) by a real `pi` invocation.
 */

import { describe, expect, it } from "vitest";
import {
	findPhaseEntries,
	noPhasesLogged,
	parseNdjsonEntries,
	phaseWasLogged,
} from "../../scripts/lib/latency-log-phases.mjs";

describe("parseNdjsonEntries", () => {
	it("parses one JSON object per line", () => {
		const text = '{"a":1}\n{"b":2}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips blank lines", () => {
		const text = '{"a":1}\n\n\n{"b":2}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips malformed/truncated lines rather than throwing", () => {
		const text = '{"a":1}\n{"b":2\n{"c":3}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { c: 3 }]);
	});

	it("returns [] for empty input", () => {
		expect(parseNdjsonEntries("")).toEqual([]);
	});
});

describe("findPhaseEntries / phaseWasLogged", () => {
	const entries = [
		{
			type: "phase",
			phase: "subagent_light_mode",
			ts: "2026-07-10T10:00:00.000Z",
		},
		{ type: "phase", phase: "slow_fs_probe", ts: "2026-07-10T10:00:01.000Z" },
		{
			type: "runner",
			phase: "subagent_light_mode",
			ts: "2026-07-10T10:00:02.000Z",
		},
		{
			type: "phase",
			phase: "subagent_light_mode",
			ts: "2026-07-10T09:00:00.000Z",
		},
	];

	it("finds phase entries by name, ignoring non-phase types", () => {
		const found = findPhaseEntries(entries, "subagent_light_mode");
		expect(found).toHaveLength(2);
	});

	it("restricts to entries at/after sinceIso when provided", () => {
		const found = findPhaseEntries(
			entries,
			"subagent_light_mode",
			"2026-07-10T09:30:00.000Z",
		);
		expect(found).toHaveLength(1);
		expect(found[0].ts).toBe("2026-07-10T10:00:00.000Z");
	});

	it("phaseWasLogged is true when at least one match exists", () => {
		expect(phaseWasLogged(entries, "subagent_light_mode")).toBe(true);
	});

	it("phaseWasLogged is false for a phase never logged", () => {
		expect(phaseWasLogged(entries, "concurrent_session_bind")).toBe(false);
	});

	it("phaseWasLogged is false when sinceIso excludes all matches", () => {
		expect(
			phaseWasLogged(
				entries,
				"subagent_light_mode",
				"2099-01-01T00:00:00.000Z",
			),
		).toBe(false);
	});

	it("skips entries with an unparseable ts when sinceIso is set", () => {
		const withBadTs = [{ type: "phase", phase: "x", ts: "not-a-date" }];
		expect(phaseWasLogged(withBadTs, "x", "2026-01-01T00:00:00.000Z")).toBe(
			false,
		);
	});

	// #2249: `concurrent_session_bind_rollup` (the session-end summary,
	// index.ts's session_shutdown handler) shares a prefix with
	// `concurrent_session_bind` (the per-bind record, #473). Exact-match only —
	// a naive substring/prefix check would conflate the two.
	it("distinguishes concurrent_session_bind from its concurrent_session_bind_rollup sibling", () => {
		const mixed = [
			{
				type: "phase",
				phase: "concurrent_session_bind",
				ts: "2026-07-10T10:00:00.000Z",
			},
			{
				type: "phase",
				phase: "concurrent_session_bind_rollup",
				ts: "2026-07-10T10:00:01.000Z",
			},
		];
		expect(findPhaseEntries(mixed, "concurrent_session_bind")).toHaveLength(
			1,
		);
		expect(
			findPhaseEntries(mixed, "concurrent_session_bind_rollup"),
		).toHaveLength(1);
		expect(phaseWasLogged(mixed, "concurrent_session_bind_rollup")).toBe(
			true,
		);
	});
});

describe("noPhasesLogged", () => {
	const entries = [
		{
			type: "phase",
			phase: "heavyweight_scan_started",
			ts: "2026-07-10T10:00:00.000Z",
		},
	];

	it("is true when none of the given phases appear", () => {
		expect(noPhasesLogged(entries, ["knip_scan", "jscpd_scan"])).toBe(true);
	});

	it("is false when any given phase appears", () => {
		expect(
			noPhasesLogged(entries, ["knip_scan", "heavyweight_scan_started"]),
		).toBe(false);
	});

	it("respects sinceIso the same way phaseWasLogged does", () => {
		expect(
			noPhasesLogged(
				entries,
				["heavyweight_scan_started"],
				"2099-01-01T00:00:00.000Z",
			),
		).toBe(true);
	});
});
