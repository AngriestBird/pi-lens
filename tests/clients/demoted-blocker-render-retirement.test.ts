/**
 * Demoted-blocker body degradation and retirement (#1944).
 *
 * The past-EOF gate (#1641) moved a blocker whose file shrank past the cited
 * lines out of the authoritative channel and into the advisory channel. It
 * changed the CHANNEL and nothing else: the advisory embedded the blocker
 * body verbatim, so the agent still read "🔴 STOP — N issue(s) must be fixed"
 * with dead line numbers, and nothing ever retired the record, so it re-served
 * on every turn end for the life of the session (measured live at 80+ minutes,
 * session 01a0234c).
 *
 * Two independent behaviors, deliberately in separate tests so each guard is
 * mutation-proof on its own (#1944 AC4):
 *   - degradation: deleting `degradeDemotedFindingBody`'s call reds the body
 *     assertions.
 *   - retirement: deleting `retireDemotedPastEofBlocker`'s call reds the
 *     one-delivery assertions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	DEAD_LINE_ANNOTATION,
	degradeDemotedFindingBody,
	formatRetirementNote,
} from "../../clients/demoted-finding-render.js";
import { _resetSharedLineCountCacheForTests } from "../../clients/diagnostic-line-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { cancelLSPIdleReset, handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

/** The exact body `formatDiagnostics(…, "blocking")` produces (format-utils.ts). */
const BLOCKER_SUMMARY = [
	"🔴 STOP — 2 issue(s) must be fixed:",
	"  L310: 'helperCache' is declared but its value is never read.",
	"    💡 Fix: remove the binding",
	"  L376: Unreachable code detected.",
].join("\n");

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

/** `advisorySections` from every `turn_end` tool_result emitted so far. */
function advisorySectionsPerTurn(): number[] {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry.metadata?.advisorySections ?? 0);
}

function retiredCountsPerTurn(): number[] {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry.metadata?.demotedFindingsRetired ?? 0);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	_resetSharedLineCountCacheForTests();
	resetDegradationLedger();
});

describe("degradeDemotedFindingBody (#1944)", () => {
	it("strips the STOP banner and the must-be-fixed imperative", () => {
		const result = degradeDemotedFindingBody(BLOCKER_SUMMARY);
		expect(result.body).not.toContain("STOP");
		expect(result.body).not.toContain("must be fixed");
		expect(result.authorityMarkersRemoved).toBeGreaterThan(0);
		// Demote, never drop: the messages survive the degradation.
		expect(result.body).toContain("'helperCache' is declared");
		expect(result.body).toContain("Unreachable code detected.");
	});

	it("annotates only the cited lines the file no longer has", () => {
		const result = degradeDemotedFindingBody(BLOCKER_SUMMARY, {
			deadLines: [376],
		});
		expect(result.body).toContain(`L376 ${DEAD_LINE_ANNOTATION}`);
		expect(result.body).not.toContain(`L310 ${DEAD_LINE_ANNOTATION}`);
		expect(result.deadLinesAnnotated).toEqual([376]);
	});

	it("leaves a body with no authority vocabulary alone", () => {
		const plain = "  L4: something mild.";
		const result = degradeDemotedFindingBody(plain);
		expect(result.body).toBe(plain);
		expect(result.authorityMarkersRemoved).toBe(0);
	});
});

describe("turn-end demoted blocker (#1944)", () => {
	/**
	 * Set up a file that shrank past its cited lines, with the blocker record
	 * still in the store. Returns the target path.
	 */
	function seedShrunkBlocker(runtime: RuntimeCoordinator, tmpDir: string): string {
		const target = path.join(tmpDir, "provider-helper.ts");
		// 3 lines now; the record cites 310 and 376.
		fs.writeFileSync(target, "const a = 1;\nconst b = 2;\nexport { a, b };\n");
		runtime.bumpFileSeq(target);
		runtime.recordInlineBlockers(target, BLOCKER_SUMMARY, 1, ["lsp"], [310, 376]);
		return target;
	}

	function markTurnModified(
		cacheManager: CacheManager,
		target: string,
		tmpDir: string,
		sessionId: string,
	): void {
		cacheManager.addModifiedRange(
			target,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			sessionId,
		);
	}

	it("degrades the demoted body: no STOP, no must-be-fixed, dead lines annotated", async () => {
		const env = setupTestEnvironment("pi-lens-1944-body-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-body" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-body");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("provider-helper.ts");
			expect(content).toContain("[stale — re-run to confirm]");
			// AC1 — the advisory carries neither authority marker.
			expect(content).not.toContain("STOP");
			expect(content).not.toContain("must be fixed");
			// AC1 — both cited lines are past EOF on a 3-line file.
			expect(content).toContain(`L310 ${DEAD_LINE_ANNOTATION}`);
			expect(content).toContain(`L376 ${DEAD_LINE_ANNOTATION}`);
			// Demote, never drop.
			expect(content).toContain("'helperCache' is declared");
		} finally {
			env.cleanup();
		}
	});

	it("retires after ONE demoted delivery instead of re-serving every turn", async () => {
		const env = setupTestEnvironment("pi-lens-1944-retire-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-retire" });
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);

			// Five consecutive edit turns. Pre-fix the record survives all five and
			// is re-served on each; the live session showed the re-serve is
			// unbounded, not capped at any particular number of turns.
			const TURNS = 5;
			const survivingAfterTurn: number[] = [];
			for (let turn = 0; turn < TURNS; turn += 1) {
				runtime.beginTurn();
				markTurnModified(cacheManager, target, env.tmpDir, "s-1944-retire");
				await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
				survivingAfterTurn.push(runtime.getInlineBlockersSnapshot().length);
			}

			// AC2 — served once, then gone. Pre-fix this reads [1,1,1,1,1].
			expect(survivingAfterTurn).toEqual([0, 0, 0, 0, 0]);
			// AC2 — exactly one turn delivered an advisory section.
			expect(advisorySectionsPerTurn()).toEqual([1, 0, 0, 0, 0]);
			// AC3 — the empty advisory sections are distinguishable: the turn that
			// dropped something says so, the four that had nothing to say do not.
			expect(retiredCountsPerTurn()).toEqual([1, 0, 0, 0, 0]);
		} finally {
			env.cleanup();
		}
	});

	it("names the suppression in the degradation ledger and in the payload", async () => {
		const env = setupTestEnvironment("pi-lens-1944-ledger-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-ledger" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-ledger");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			// AC3 — a bounded record naming the store, the file, the dropped lines,
			// and the reason.
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "demoted-finding-retired",
			);
			expect(group).toBeDefined();
			expect(group?.count).toBe(1);
			const entry = group?.latestReasons[0];
			expect(entry?.subject).toContain("inline-blocker:");
			expect(entry?.subject).toContain("provider-helper.ts");
			expect(entry?.reason).toContain("310");
			expect(entry?.reason).toContain("376");
			expect(entry?.reason).toContain("shrank past cited line");

			// AC3 — the payload itself says something was dropped, so an EMPTY
			// advisory section can only mean "nothing to say".
			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("Retired after this delivery");
			expect(content).toContain("will not be served again");

			// The retired payload must not survive as a suppression signature.
			expect(
				cacheManager.readCache("turn-end-findings-last", env.tmpDir),
			).toBeFalsy();
		} finally {
			env.cleanup();
		}
	});

	it("does not retire a dependency-drift demotion — its coordinates still exist", async () => {
		const env = setupTestEnvironment("pi-lens-1944-drift-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-drift" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "in-bounds.ts");
			fs.writeFileSync(target, "const a = 1;\nconst b = 2;\nexport { a, b };\n");
			runtime.bumpFileSeq(target);
			runtime.recordInlineBlockers(target, BLOCKER_SUMMARY, 1, ["lsp"], [2]);
			// The drift gate's own demotion, on an IN-BOUNDS cited line.
			expect(runtime.markInlineBlockerStale(target, "dependency-drift")).toBe(
				true,
			);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-drift");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			// Still in the store: a re-run CAN confirm line 2, so #1419's
			// demote-not-drop rule stands for this gate.
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(retiredCountsPerTurn()).toEqual([0]);

			// It DOES get the body degradation — that half of the rule applies to
			// every demotion, whatever gate made it.
			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).not.toContain("STOP");
			expect(content).not.toContain("must be fixed");
			// No dead lines to annotate: the cited coordinate is still in bounds.
			expect(content).not.toContain(DEAD_LINE_ANNOTATION);
			expect(content).not.toContain("Retired after this delivery");
		} finally {
			env.cleanup();
		}
	});
});

describe("formatRetirementNote (#1944)", () => {
	it("names the dead lines", () => {
		expect(formatRetirementNote([310, 376])).toContain("lines 310, 376");
		expect(formatRetirementNote([9])).toContain("line 9");
	});
});
