// flake-shape: real-process-spawn — drives the analyzer's real CLI entry point over fixtures, like the sibling analyze-pi-lens-logs.test.ts.
/**
 * #3870: `scripts/analyze-pi-lens-logs.mjs` detects the live-session smells
 * (D1-D16 add, E1-E5 enhance, R1-R2 remove).
 *
 * Fixtures are redacted cuts of the read-only forensics session logs unless a
 * test comment labels a minimal synthetic boundary row. Each test pins one report row's
 * match rule and its expected count from section 8.2. The quoted transcript in
 * each header is the real log line the detector must catch (or, for E1/E2/E3,
 * the real false positive the enhancement must stop counting).
 *
 * The script runs through its real entry point (subprocess with --root/--json)
 * exactly like `analyze-pi-lens-logs.test.ts`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT =
	process.env.PI_LENS_ANALYZE_SCRIPT ??
	path.resolve(HERE, "../../scripts/analyze-pi-lens-logs.mjs");
const FIXTURES = path.resolve(HERE, "../fixtures/analyze-logs");

interface Smell {
	id: string;
	count: number;
	severity: string;
	description: string;
	examples: any[];
}

function run(fixture: string, since = "all"): any {
	const out = execFileSync(
		process.execPath,
		[
			SCRIPT,
			"--root",
			path.join(FIXTURES, fixture),
			"--json",
			"--since",
			since,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
}

function smell(report: any, id: string): Smell | undefined {
	return report.smells.find((entry: Smell) => entry.id === id) as
		| Smell
		| undefined;
}

describe("analyze-pi-lens-logs.mjs D1-D16 detectors (#3870)", () => {
	it("D1 log-coverage-gap: flags a 10min+ latency gap a live session filled", () => {
		// latency.log.1 last: ...lsp_touch_file ... 2026-09-30T11:52:18.708Z
		// latency.log  first: {"phase":"degradation_ledger",... "ledgerGeneration":31,
		//                      "ts":"2026-09-30T13:08:41.562Z"}
		const report = run("log-coverage-gap");
		const gaps = report.detectors.logCoverageGap.gaps;
		expect(gaps).toHaveLength(1);
		expect(gaps[0].minutes).toBe(76);
		expect(gaps[0].sessionstartRows).toBe(25);
		expect(smell(report, "log-coverage-gap")?.count).toBe(1);
	});

	it("F8: ledger generation is not treated as a log rotation marker", () => {
		const report = run("log-coverage-gap");
		expect(report.detectors.logCoverageGap.rotationTruncation).toBeNull();
		expect(smell(report, "log-rotation-truncation")).toBeUndefined();
	});

	it("D2 real-log-test-pollution: only test-home markers count as pollution", () => {
		// latency (pid 820094): {"phase":"degradation_ledger","filePath":".../review-3703/.probe-home/pi-lens-3521-witness-home-820094/instances.json",...}
		// extension (pid 240029): {"level":"debug","subsystem":"tool-cwd","message":"cwd runner pytest cwd=.../pi-lens-test-checkout-isolation-xNZNoE/..."}
		const report = run("real-log-test-pollution");
		const d2 = report.detectors.realLogTestPollution;
		// two real `.probe-home/` rows plus the labelled synthetic witness-home row
		expect(d2.latencyByPid).toEqual({ "820094": 3 });
		expect(d2.extensionByPid).toEqual({ "240029": 2 });
		expect(smell(report, "real-log-test-pollution")?.count).toBe(5);
	});

	it("D2 extension-warn-errors: groups warn and error rows only", () => {
		// {"level":"error","subsystem":"dispatch","message":"yamllint: no config detected, running with default rules"} x2
		// {"level":"error","subsystem":"lsp-diagnostics","message":"lens_diagnostics verdict"}; three debug rows are not groups
		const report = run("real-log-test-pollution");
		expect(report.detectors.extensionWarnErrors).toEqual({
			"dispatch: yamllint: no config detected, running with default rules": 2,
			"lsp-diagnostics: lens_diagnostics verdict": 1,
		});
		expect(smell(report, "extension-warn-errors")?.count).toBe(2);
	});

	it("F2: a real session editing under pi-lens-worktrees is not pollution", () => {
		// Recurrence: r1/r2 flagged pid 1947541, a 1.5-day real session, as
		// "never belongs in a real log" because its edits live under
		// ~/Desktop/pi-lens-worktrees. Real rows: tool_result_received
		// toolName:edit and config_resolved on .../fix-3643-review/clients/mcp,
		// two opaque command rows, /tmp/pi-lens-ast-grep (pid 3103055), and the
		// extension row of pid 650812 on .../pi-lens-worktrees/review-3673.
		const report = run("real-log-test-pollution");
		const d2 = report.detectors.realLogTestPollution;
		expect(d2.latencyByPid["1947541"]).toBeUndefined();
		expect(d2.latencyByPid["3103055"]).toBeUndefined();
		expect(d2.extensionByPid["650812"]).toBeUndefined();
	});

	it("D3 turn-end-tests-excluded: flags the run that excluded its test files", () => {
		// [2026-09-30T21:47:54.336Z] turn_end: .worktrees/245-branch-lock-backlog/tests/unit/state-reaper.test.ts
		//   -> test target excluded by the built-in turn-end policy, skipping spawn (...)
		const report = run("turn-end-tests-excluded");
		const runs = report.detectors.turnEndTestsExcluded.runs;
		expect(runs).toHaveLength(1);
		expect(runs[0].excluded).toBe(3);
		expect(runs[0].ran).toBe(0);
		expect(runs[0].edits).toBe(1);
		expect(smell(report, "turn-end-tests-excluded")?.count).toBe(1);
	});

	it("D4 test-target-cross-checkout: flags failed-first targets in another checkout", () => {
		// [2026-09-30T11:07:31.035Z] turn_end: .worktrees/471-retained-trees/src/workspace.ts
		//   -> test vitest .worktrees/450-merge-into/tests/unit/workspace.test.ts (failed-first)
		const report = run("test-target-cross-checkout");
		const cross = report.detectors.testTargetCrossCheckout.runs.reduce(
			(n: number, r: any) => n + (r.crossCheckout >= 3 ? r.crossCheckout : 0),
			0,
		);
		expect(cross).toBe(6);
		expect(smell(report, "test-target-cross-checkout")?.count).toBe(6);
	});

	it("D5 test-runner-stale-verdicts: joins firings/stale text to delivery outcomes", () => {
		// [2026-09-30T20:40:34.636Z] turn_end: all tests passed (stale — turn advanced while tests ran)
		const report = run("test-runner-stale-verdicts");
		const d5 = report.detectors.testRunnerStaleVerdicts;
		expect(d5.firings).toBe(10);
		expect(d5.stale).toBe(5);
		expect(d5.textFlag).toBe(true);
		expect(d5.lowDelivery.length).toBeGreaterThanOrEqual(1);
		expect(smell(report, "test-runner-stale-verdicts")?.count).toBe(5);
	});

	it("D6 scanner-count-drift and turn-end-knip-cost: flags drift and cost pids", () => {
		// {"phase":"knip","durationMs":7878,"metadata":{"execution":"executed","totalIssues":16187,...}}
		const report = run("knip");
		expect(report.detectors.knip.drift.length).toBe(2);
		expect(report.detectors.knip.cost.length).toBe(1);
		expect(smell(report, "scanner-count-drift")?.count).toBe(2);
		expect(smell(report, "turn-end-knip-cost")?.count).toBe(1);
	});

	it("D7 hook-await-exceeded: reports every overrun with its budget ratio", () => {
		// {"phase":"degradation_ledger","metadata":{"hook":"tool_result_edit","label":"registered-handler",
		//  "budgetMs":"10000","elapsedMs":"11398","kind":"hook-await-exceeded",...}}
		const report = run("hook-await-exceeded");
		expect(report.detectors.hookAwait.rows).toHaveLength(8);
		expect(report.detectors.hookAwait.over).toBe(4);
		expect(smell(report, "hook-await-exceeded")?.count).toBe(8);
	});

	it("D8 turn-end-slow: flags the pid whose turn_end summaries overrun", () => {
		// {"type":"tool_result","toolName":"turn_end","durationMs":10188,"metadata":{"blockerSections":0,...}}
		const report = run("turn-end-slow");
		const flagged = report.detectors.turnEndSlow.flagged;
		expect(flagged).toHaveLength(1);
		expect(flagged[0].slow).toBe(14);
		expect(flagged[0].max).toBe(10188);
		expect(smell(report, "turn-end-slow")?.count).toBe(1);
		expect(smell(report, "turn-end-retained-state")?.count).toBe(1);
	});

	it("D9 lsp-wait-empty-candidates: empty waits, no-client edits, warm-reuse clashes", () => {
		// {"phase":"lsp_touch_file",...,"metadata":{"source":"tool_call:edit","failureKind":"no_clients_none_spawning"}}
		// {"phase":"lsp_client_selected","metadata":{"serverId":"typescript","outcome":"warm-reuse"}}
		const report = run("lsp-wait-empty-candidates");
		const d9 = report.detectors.lspWait;
		expect(d9.empty).toHaveLength(1);
		expect(d9.empty[0].ms).toBe(14500);
		expect(d9.noClients).toHaveLength(1);
		expect(d9.noClients[0].noClients).toBe(9);
		expect(d9.contradictions).toHaveLength(10);
		expect(d9.pidCount).toBe(2);
		expect(smell(report, "lsp-wait-empty-candidates")?.count).toBe(2);
	});

	it("D10 resume-state-loss: separates a lost read set from a genuine zero_read", () => {
		// {"event":"edit_blocked","filePath":".../471-retained-trees/src/workspace.ts",
		//  "metadata":{"readCount":0,"reads":[],"verdictAction":"block","reasonKind":"zero_read"}}
		const report = run("resume-state-loss");
		expect(report.detectors.resumeStateLoss.stateLost).toHaveLength(2);
		expect(report.detectors.resumeStateLoss.genuine).toHaveLength(1);
		expect(smell(report, "resume-state-loss")?.count).toBe(2);
	});

	it("F3: a window starting mid-session carries every read-evidence kind", () => {
		// Recurrence: r2 carried only edit_batch_summary across the --since edge,
		// so a 12:00Z window called workspace.ts (whose only pre-window row here
		// is range_snapshot_validation candidateReadCount 1 at 11:07:27Z)
		// genuine. Pre-window rows live in read-guard.log.1, the blocks in
		// read-guard.log, so reading the rotated file first is also pinned.
		const report = run("window-anchors", "2026-09-30T12:00:00Z");
		const d10 = report.detectors.resumeStateLoss;
		const base = (r: any) => path.basename(r.filePath);
		expect(d10.stateLost.map(base).sort()).toEqual([
			"warned-only.ts",
			"workspace.ts",
			"worktree-captured-dirt.test.ts",
		]);
		expect(d10.genuine.map(base).sort()).toEqual([
			"router.ts",
			"unread-a.ts",
			"unread-b.ts",
		]);
		expect(smell(report, "resume-state-loss")?.count).toBe(3);
	});

	it("F3: a window starting after session_start fired keeps the D3 run", () => {
		// Recurrence: r1 dropped the final run when its `session_start fired`
		// (20:51:33Z) preceded the window, so --since 21:00Z zeroed D3.
		const report = run("window-anchors", "2026-09-30T21:00:00Z");
		const runs = report.detectors.turnEndTestsExcluded.runs;
		expect(runs).toHaveLength(1);
		expect(runs[0].startTs).toBe("2026-09-30T20:51:33.141Z");
		expect(runs[0].excluded).toBe(2);
		expect(smell(report, "turn-end-tests-excluded")?.count).toBe(1);
	});

	it("D11 carry-empty-restart: flags an empty carry into a populated branch", () => {
		// {"phase":"read_guard_branch_retained","metadata":{"trigger":"startup","source":"own-sidecar",
		//  "kept":0,"dropped":0,"branchToolResults":1034,"branchReadable":true}}
		const report = run("carry-empty-restart");
		const carry = report.detectors.carryEmptyRestart;
		expect(carry).toHaveLength(1);
		expect(carry[0].branchToolResults).toBe(1034);
		expect(smell(report, "carry-empty-restart")?.count).toBe(1);
	});

	it("D12 restart-self-nudge: flags a cross-process nudge after a handoff", () => {
		// {"phase":"agent_nudge","metadata":{"originLocal":0,"originCrossProcess":1,...}}
		const report = run("restart-self-nudge");
		expect(report.detectors.restartSelfNudge).toHaveLength(2);
		expect(smell(report, "restart-self-nudge")?.count).toBe(2);
		expect(smell(report, "restart-self-nudge")?.description).toContain(
			"suspect-grade",
		);
	});

	it("D13 deferred-runner-failed-undelivered: joins a failed collect-later runner to delivery", () => {
		// {"type":"runner","runnerId":"lsp","status":"failed","diagnosticCount":27,
		//  "metadata":{"tier":"collect-later","delivered":"turn_end"}} then
		// {"phase":"late_runner_findings","metadata":{"failed":1,"delivered":0,"dropped":0,...}}
		const report = run("deferred-runner-failed-undelivered");
		const flags = report.detectors.deferredRunnerFailedUndelivered;
		expect(flags).toHaveLength(1);
		expect(flags[0].diagnosticCount).toBe(27);
		expect(smell(report, "deferred-runner-failed-undelivered")?.count).toBe(1);
	});

	it("D14 aux-stuck-pair: flags an auxiliary pair stuck in two turn ends", () => {
		// {"phase":"late_auxiliary_findings","metadata":{"stuckPairs":[{"filePath":".../src/workspace.ts","serverId":"opengrep"}]}}
		const report = run("aux-stuck-pair");
		expect(report.detectors.auxStuckPairs).toHaveLength(3);
		expect(smell(report, "aux-stuck-pair")?.count).toBe(3);
	});

	it("D15 advisory-provenance-unknown: flags malformed-or-legacy provenance", () => {
		// {"phase":"advisory_provenance_decision","metadata":{"decision":"historical",
		//  "reasons":["malformed-or-legacy-provenance"],"provenanceStamp":"session unknown / turn unknown / generation unknown"}}
		const report = run("advisory-provenance-unknown");
		const rows = report.detectors.advisoryProvenanceUnknown;
		expect(rows).toHaveLength(1);
		expect(rows[0].secondsSinceFirstRow).toBeTypeOf("number");
		expect(smell(report, "advisory-provenance-unknown")?.count).toBe(1);
	});

	it("D16 slow-extension-load: flags pi-lens loads at or above 2s", () => {
		// [2026-09-30T12:25:38.171Z] pi-lens loaded: 6123ms after process start (from dist)
		const report = run("slow-extension-load");
		expect(report.detectors.slowExtensionLoad).toHaveLength(3);
		// A load with a session start at its own ms or at +60000 ms is not
		// short-lived; one at +60001 ms is. This pins both window edges.
		expect(
			report.detectors.slowExtensionLoad.filter((l: any) => l.shortLived),
		).toHaveLength(1);
		expect(smell(report, "slow-extension-load")?.count).toBe(3);
	});
});

describe("analyze-pi-lens-logs.mjs E1-E5 enhancements (#3870)", () => {
	it("E1 lsp-availability-noise: path tokens cannot match the failure words", () => {
		// false: "lsp launch: command=... cwd=.../.worktrees/468-wait-timeout shell=false pid=384054"
		// real:  "[...] lsp spawn marksman: failed (15299ms) error=Timeout after 15000ms"
		const report = run("lsp-availability-noise");
		expect(smell(report, "lsp-availability-noise")?.count).toBe(2);
	});

	it("F1: matches the launch-candidate failure emitted by the LSP server", () => {
		const report = run("lsp-availability-noise");
		expect(smell(report, "lsp-availability-noise")?.count).toBe(2);
	});

	it("F4: E2 reports blocks without claiming an unobservable host/model split", () => {
		// edit_blocked + edit_preflight_blocked are blocks; edit_warned is informational.
		const report = run("read-guard-blocks");
		expect(report.readGuard.events.edit_blocked).toBe(3);
		expect(report.readGuard.events.edit_preflight_blocked).toBe(3);
		expect(report.readGuard.warns).toHaveLength(5);
		expect(report.readGuard.modelSideBlock).toBeUndefined();
		expect(report.readGuard.hostSideFalseBlock).toBeUndefined();
		expect(smell(report, "read-guard-blocks")?.count).toBe(6);
	});

	it("E3 read-guard-stale-ranges: bypassed-content-match is not a stale read", () => {
		// {"event":"range_snapshot_validation","metadata":{"status":"mismatch",...,"outcome":"bypassed-content-match"}}
		// one synthetic enforced-block mismatch is the only real stale range.
		const report = run("read-guard-stale-ranges");
		expect(report.readGuard.bypassedMismatch).toBe(3);
		expect(report.readGuard.staleRanges).toHaveLength(1);
		expect(smell(report, "read-guard-stale-ranges")?.count).toBe(1);
	});

	it("E4 session starts count from `session_start fired` with build attribution", () => {
		// [2026-09-30T20:51:33.141Z] session_start fired
		// [2026-09-30T20:51:33.142Z] session_start: build identity — commit=cf1b548e ...
		const report = run("session-starts-build-attribution");
		expect(report.session.starts).toBe(4);
		expect(report.session.commits).toEqual({
			"4b6a3f53": 2,
			"64163cc9": 1,
			cf1b548e: 1,
		});
	});

	it("E5 Projects touched: a bash command filePath is not a project", () => {
		// {"phase":"opaque_mutation_prescan","filePath":"cd /home/user/Desktop/proj/.worktrees/231-ask3 && python3 - <<'PY'..."}
		const report = run("projects-touched");
		expect(
			report.projects.filter((p: any) => p.key.includes("&&")),
		).toHaveLength(0);
		expect(report.projects.find((p: any) => p.key === "home")?.count).toBe(6);
	});
});

describe("analyze-pi-lens-logs.mjs R1-R2 removals (#3870)", () => {
	it("R1 removes the dead session.rotations counter", () => {
		const report = run("advisory-provenance-unknown");
		expect(report.session.rotations).toBeUndefined();
	});

	it("R2 read-guard examples carry the real line, not the undefined offset fields", () => {
		const report = run("resume-state-loss");
		for (const row of report.readGuard.stateLost) {
			expect(typeof row.line).toBe("number");
			expect(row.requestedOffset).toBeUndefined();
			expect(row.symbolStartLine).toBeUndefined();
		}
	});

	it("stays read-only: running writes nothing under the fixture root", () => {
		const root = path.join(FIXTURES, "log-coverage-gap");
		const before = fs.readdirSync(root).sort();
		run("log-coverage-gap");
		const after = fs.readdirSync(root).sort();
		expect(after).toEqual(before);
	});
});
