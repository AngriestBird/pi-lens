/**
 * #3218 criterion 2 — the turn-end "Resolved this turn" line.
 *
 * Recurrence (2026-09-19 pi-webaio session, turns 300-302): an inline blocker
 * recorded on an edit (`osTmpdir` unused, 08:40:05) was retired by the next
 * dispatch of the same file (08:40:54, "clean"), and a second (`FetchError`
 * unused, 07:23:34) retired at 07:27. Neither was ever re-delivered — the
 * turn-state, the session record, the project snapshot and every context
 * injection were checked. At 08:54 the agent re-read its own STOP blocks from
 * context and spent two turns re-litigating whether the two ts:6133 hints were
 * real. pi-lens gave the agent the negative (a later clean result) but never
 * the positive: nothing said the blocker it had been shown was closed.
 *
 * The tests drive the REAL `RuntimeCoordinator` retire seams and the REAL
 * turn-end composer (`handleTurnEnd`), then read the delivered content the way
 * production does (`consumeTurnEndFindings`) and the `turn_end` `tool_result`
 * row the monitor reads.
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
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
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

const SUMMARY = "🔴 STOP — 2 issue(s) must be fixed:\n  L1: b0\n  L2: b1";

function blockerDiagnostics(count: number): Diagnostic[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `b${index}`,
		message: `blocker ${index}`,
		filePath: "a.ts",
		line: index + 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
	}));
}

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

/** End one turn and return what the agent sees, consumed like production. */
async function runTurnEnd(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): Promise<string> {
	await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime)?.messages?.[0]
			?.content ?? ""
	);
}

/** `resolvedBlockerFiles` from every `turn_end` tool_result so far. */
function resolvedBlockerFileCounts(): Array<number | undefined> {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry?.metadata?.resolvedBlockerFiles);
}

/** Seed a recorded blocker, a clean dispatch that clears it, a touched turn. */
function seedResolvedBlocker(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	target: string,
): void {
	fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
	runtime.bumpFileSeq(target);
	runtime.recordInlineBlockers(
		target,
		SUMMARY,
		3,
		["lsp"],
		[1, 2],
		undefined,
		blockerDiagnostics(2),
	);
	// The next dispatch of the same file comes back clean under a later write.
	runtime.clearInlineBlockers(target, 5);
	cacheManager.addModifiedRange(
		target,
		{ start: 1, end: 1 },
		false,
		cwd,
		"session-3218",
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	resetDegradationLedger();
});

describe("turn-end resolved blockers (#3218 criterion 2)", () => {
	it("names a file whose blocker a clean dispatch retired, with count and write", async () => {
		const env = setupTestEnvironment("pi-lens-3218-resolved-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).toContain(
				"Resolved this turn: a.ts (2 blocker(s) cleared by the 5th write)",
			);
			expect(resolvedBlockerFileCounts()).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it("names a file retired by a confirmed-clean check, from the write-order token", async () => {
		const env = setupTestEnvironment("pi-lens-3218-retire-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
			const recordOrder = runtime.nextWriteIndex();
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				recordOrder,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			// `lens_diagnostics` reserves a turn-leading order token (#3540).
			const order = runtime.nextWriteOrderToken();
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(target, order, ["lsp"]),
			).toBe(true);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).toContain(
				"Resolved this turn: a.ts (2 blocker(s) cleared by the 2nd write)",
			);
			expect(resolvedBlockerFileCounts()).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it("does not invent a resolved line when no blocker was recorded", async () => {
		const env = setupTestEnvironment("pi-lens-3218-none-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.bumpFileSeq(target);
			// A clean dispatch for a file that never had a blocker.
			expect(runtime.clearInlineBlockers(target, 1)).toBe(true);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("Resolved this turn");
			expect(resolvedBlockerFileCounts()).toEqual([0]);
		} finally {
			env.cleanup();
		}
	});

	it("delivers the line once, then stays silent", async () => {
		const env = setupTestEnvironment("pi-lens-3218-once-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);

			const first = await runTurnEnd(runtime, cacheManager, env.tmpDir);
			expect(first).toContain("Resolved this turn: a.ts");

			// The next turn retires nothing new: the list was consumed, so the
			// line cannot re-serve (the criterion's "one delivery per
			// retirement, then silent").
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);
			const second = await runTurnEnd(runtime, cacheManager, env.tmpDir);
			expect(second).not.toContain("Resolved this turn");
			expect(resolvedBlockerFileCounts()).toEqual([1, 0]);
		} finally {
			env.cleanup();
		}
	});

	it("caps the lines at 10 files and counts the overflow", async () => {
		const env = setupTestEnvironment("pi-lens-3218-cap-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			for (let index = 0; index < 11; index += 1) {
				const file = path.join(env.tmpDir, `file-${index}.ts`);
				fs.writeFileSync(file, "const a = 1;\n");
				runtime.recordInlineBlockers(
					file,
					SUMMARY,
					index + 1,
					["lsp"],
					[1, 2],
					undefined,
					blockerDiagnostics(2),
				);
				runtime.clearInlineBlockers(file, index + 1);
			}
			const first = path.join(env.tmpDir, "file-0.ts");
			cacheManager.addModifiedRange(
				first,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content.match(/Resolved this turn:/g) ?? []).toHaveLength(10);
			expect(content).toContain("… and 1 more");
			expect(resolvedBlockerFileCounts()).toEqual([10]);
		} finally {
			env.cleanup();
		}
	});

	it("does not claim a file resolved while it is blocking again this turn", async () => {
		const env = setupTestEnvironment("pi-lens-3218-reblock-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.bumpFileSeq(target);
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				1,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			runtime.clearInlineBlockers(target, 2);
			// A later edit re-records the blocker; the current truth is blocking.
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				3,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("Resolved this turn");
			expect(content).toContain("Unresolved from this turn");
		} finally {
			env.cleanup();
		}
	});
});
