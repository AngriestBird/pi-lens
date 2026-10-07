/**
 * #3813 / #3901 — an item-bearing advisory that `handleTurnEnd` derives from
 * "what this turn changed" must not be lost when `capTurnEndMessage` cuts it.
 *
 * Recurrence (PR #3900 residuals, #3901): knip and dead-code deltas are
 * `this scan minus the previous scan`, and the scan cache is overwritten
 * BEFORE the cap runs, so an item the cap cut never reappeared as new on the
 * next turn. The call-graph impact lines are derived from the turn's edited
 * files, which the worklist retires once a turn ends without blockers. The
 * `planDeliveryHolds` seam (#3900) restores drained queues; these producers
 * have no queue, so a cut part parks its items in `runtime.advisoryCarry`
 * (one turn, re-checked against the next scan) instead.
 *
 * Every test drives the REAL `handleTurnEnd` and reads the delivered message
 * the way production does. The cap is never mocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: () => makeLspServiceDouble({}),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			logLatency(entry);
			actual.logLatency(entry);
		},
	};
});

import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import { CacheManager } from "../../clients/cache-manager.js";
import type { FunctionCallGraph } from "../../clients/call-graph.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetStateCacheForTests } from "../../clients/diagnostic-dispositions.js";
import { loadProjectDiagnosticsDeltaReport } from "../../clients/project-diagnostics/cache.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import {
	MAX_CUT_ADVISORY_LANES,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION = "session-3901";

const EMPTY_KNIP = {
	success: true,
	issues: [] as Array<Record<string, unknown>>,
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "ok",
};

interface Scan {
	knip: Array<Record<string, unknown>>;
	/** The next knip scan fails (a timeout), leaving the last good cache. */
	knipFails?: boolean;
	deadCode: Array<Record<string, unknown>>;
}

interface Rig {
	cwd: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	/** What the next scans report; mutated between turns. */
	scan: Scan;
	cleanup: () => void;
}

function makeRig(prefix: string): Rig {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	runtime.beginTurn();
	const cacheManager = new CacheManager(false);
	// The baselines the deltas are computed against.
	cacheManager.writeCache("knip", { ...EMPTY_KNIP }, env.tmpDir);
	cacheManager.writeCache(
		"dead-code-vulture",
		{ ...EMPTY_KNIP, language: "python" },
		env.tmpDir,
	);
	return {
		cwd: env.tmpDir,
		runtime,
		cacheManager,
		scan: { knip: [], deadCode: [] },
		cleanup: env.cleanup,
	};
}

function makeDeps(rig: Rig) {
	return {
		ctxCwd: rig.cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime: rig.runtime,
		cacheManager: rig.cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () =>
				rig.scan.knipFails
					? { ...EMPTY_KNIP, success: false, summary: "knip failed" }
					: {
							...EMPTY_KNIP,
							issues: rig.scan.knip,
							unusedExports: rig.scan.knip,
						},
		},
		deadCodeClients: [
			{
				id: "vulture",
				language: "python",
				detect: () => true,
				owns: () => true,
				ensureAvailable: async () => true,
				analyze: async () => ({
					...EMPTY_KNIP,
					language: "python",
					unusedExports: rig.scan.deadCode,
				}),
			},
		],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

function touch(rig: Rig, name: string, content = "export const a = 1;\n") {
	const file = path.join(rig.cwd, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	rig.runtime.bumpFileSeq(file);
	rig.cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		rig.cwd,
		SESSION,
	);
	return file;
}

async function endTurn(rig: Rig): Promise<string> {
	await handleTurnEnd(makeDeps(rig));
	return (
		consumeTurnEndFindings(rig.cacheManager, rig.cwd, rig.runtime)
			?.messages?.[0]?.content ?? ""
	);
}

/** Next turn with a noise edit so the signature dedupe never hides a re-offer. */
function nextTurn(rig: Rig, turn: number): void {
	rig.runtime.beginTurn();
	touch(rig, `noise-${turn}.ts`, `export const n${turn} = ${turn};\n`);
}

/**
 * A live blocker whose part is EXACTLY `chars` long, so the part after it
 * starts at `chars + 2` and the cap cell it lands in is arithmetic.
 */
function fillerBlocker(rig: Rig, chars: number): string {
	const file = touch(rig, "filler.ts");
	const prefix = "Unresolved from this turn — filler.ts:\n";
	const header = "🔴 STOP — filler blocker";
	const lines: string[] = [];
	let remaining = chars - prefix.length - header.length;
	while (remaining > 1) {
		const n = Math.min(100, remaining - 1);
		lines.push("x".repeat(n));
		remaining -= n + 1;
	}
	const summary = [header + "x".repeat(Math.max(0, remaining)), ...lines].join(
		"\n",
	);
	rig.runtime.recordInlineBlockers(
		file,
		summary,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[1],
	);
	return file;
}

function clearFiller(rig: Rig, file: string): void {
	rig.runtime.clearInlineBlockers(file, rig.runtime.nextWriteIndex());
}

/** What a turn that ended without blockers does to the edited-file worklist. */
function retireWorklist(rig: Rig): void {
	rig.cacheManager.clearTurnState(rig.cwd, { kind: "pi", id: SESSION });
}

function ledgerCount(kind: string): number {
	return getDegradationSummary()
		.filter((entry) => entry.kind === kind)
		.reduce((sum, entry) => sum + entry.count, 0);
}

beforeEach(() => {
	_resetStateCacheForTests();
	resetDegradationLedger();
	resetBoundedTelemetry();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	resetDegradationLedger();
	resetBoundedTelemetry();
});

/**
 * Where the part lands relative to the cap. The filler is the live blocker
 * riding before it; the next part starts at `filler + 2` and the cap keeps
 * 1000 chars. Every fixture part is 110-300 chars, so 300 fits it whole, 930
 * cuts it mid-text and 1000 cuts it away entirely.
 */
const CELLS = [
	{ cell: "fits", filler: 300, reached: true },
	{ cell: "partially cut", filler: 930, reached: false },
	{ cell: "fully cut", filler: 1000, reached: false },
] as const;

describe("knip blocker vs the cap (#3901)", () => {
	const issue = {
		type: "unlisted",
		name: "left-pad",
		file: "edited.ts",
		line: 1,
	};

	it.each(CELLS)(
		"$cell: a cut blocker is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-knip-blocker-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				touch(rig, "edited.ts");
				rig.scan.knip = [issue];

				const first = await endTurn(rig);
				expect(first.includes("left-pad")).toBe(reached);

				// The same scan again: the issue is in the baseline now.
				clearFiller(rig, fillerFile);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("left-pad")).toBe(!reached);

				nextTurn(rig, 3);
				const third = await endTurn(rig);
				expect(third).not.toContain("left-pad");
			} finally {
				rig.cleanup();
			}
		},
	);

	it("re-offers a cut blocker though the turn worklist was retired", async () => {
		const rig = makeRig("pi-lens-3901-knip-worklist-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			expect(await endTurn(rig)).not.toContain("left-pad");

			// A turn that ended without blockers retires the worklist; the cut
			// item's file is no longer "modified" on the next turn.
			clearFiller(rig, fillerFile);
			retireWorklist(rig);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	it("does not re-offer a cut item the next scan no longer reports", async () => {
		const rig = makeRig("pi-lens-3901-knip-fresh-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			await endTurn(rig);

			// The agent fixed it between the turns: a stale nudge is worse than none.
			clearFiller(rig, fillerFile);
			rig.scan.knip = [];
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	it("bounds the carry: an item cut on two consecutive turns is dropped with one record", async () => {
		const rig = makeRig("pi-lens-3901-knip-bound-");
		try {
			fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			await endTurn(rig);

			// The filler stays live: the carried item is cut again.
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);

			nextTurn(rig, 3);
			expect(await endTurn(rig)).not.toContain("left-pad");
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);
		} finally {
			rig.cleanup();
		}
	});
});

describe("knip carry bounds and neighbours (#3901)", () => {
	const issue = (name: string) => ({
		type: "unlisted",
		name,
		file: "edited.ts",
		line: 1,
	});

	// Recurrence guard: a carried item riding beside a fresh one would be
	// re-parked with it and re-offered every turn (shape 9, one-axis bound).
	it("parks only the fresh item of a part that mixes a re-offer and a new one", async () => {
		const rig = makeRig("pi-lens-3901-knip-mixed-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("pkg-old")];
			await endTurn(rig);

			// Turn 2: the old item is re-offered beside a new one, filler still live.
			nextTurn(rig, 2);
			rig.scan.knip = [issue("pkg-old"), issue("pkg-new")];
			expect(await endTurn(rig)).not.toContain("pkg-");
			// pkg-old was a re-offer: dropped and counted. pkg-new: parked.
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 3);
			const third = await endTurn(rig);
			expect(third).toContain("pkg-new");
			expect(third).not.toContain("pkg-old");

			nextTurn(rig, 4);
			expect(await endTurn(rig)).not.toContain("pkg-");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: a failed scan must not spend the parked item (the
	// poison guard keeps the last good cache; the item is still unannounced).
	it("keeps a parked item across a failed scan and offers it on the next good one", async () => {
		const rig = makeRig("pi-lens-3901-knip-failed-scan-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.scan.knipFails = true;
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");

			rig.scan.knipFails = false;
			nextTurn(rig, 3);
			expect(await endTurn(rig)).toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: parked state is a fact about the session that parked it.
	it("a new session does not inherit a parked item", async () => {
		const rig = makeRig("pi-lens-3901-knip-session-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.runtime.resetForSession();
			rig.runtime.setTelemetryIdentity({ sessionId: SESSION });
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard (#3901 AC2): the shared caches `lens_diagnostics` reads
	// are never mutated by the hold, and a re-offer does not write the item into
	// the delta a second time.
	it("leaves the knip cache and the persisted delta exactly as an uncut turn writes them", async () => {
		const rig = makeRig("pi-lens-3901-knip-caches-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			const cached = rig.cacheManager.readCache<{
				issues: Array<{ name: string }>;
			}>("knip", rig.cwd);
			expect(cached?.data.issues.map((i) => i.name)).toEqual(["left-pad"]);
			const delta = loadProjectDiagnosticsDeltaReport(rig.cwd);
			expect(JSON.stringify(delta?.diagnostics)).toContain("left-pad");

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain("left-pad");
			expect(
				rig.cacheManager.readCache<{ issues: unknown[] }>("knip", rig.cwd)?.data
					.issues,
			).toHaveLength(1);
			// The re-offer finds nothing NEW, so it writes no delta of its own: the
			// cut turn's report is byte-for-byte what it was.
			expect(loadProjectDiagnosticsDeltaReport(rig.cwd)).toEqual(delta);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: the parked-lane store is bounded on the lane axis too.
	it("evicts the oldest parked lane past the bound and says so", () => {
		const runtime = new RuntimeCoordinator();
		for (let i = 0; i < MAX_CUT_ADVISORY_LANES; i += 1) {
			expect(runtime.parkCutAdvisoryItems(`lane-${i}`, [i])).toEqual([]);
		}
		expect(runtime.parkCutAdvisoryItems("lane-over", [1])).toEqual(["lane-0"]);
		expect(runtime.takeCutAdvisoryItems("lane-0")).toEqual([]);
		expect(runtime.takeCutAdvisoryItems("lane-over")).toEqual([1]);
		// Taken once.
		expect(runtime.takeCutAdvisoryItems("lane-over")).toEqual([]);
	});
});

describe("knip advisory vs the cap (#3901)", () => {
	const issue = {
		type: "export",
		name: "orphanFn",
		file: "edited.ts",
		line: 1,
	};

	it.each(CELLS)(
		"$cell: a cut advisory is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-knip-advisory-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				touch(rig, "edited.ts");
				rig.scan.knip = [issue];

				const first = await endTurn(rig);
				expect(first.includes("orphanFn")).toBe(reached);

				clearFiller(rig, fillerFile);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("orphanFn")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("orphanFn");
			} finally {
				rig.cleanup();
			}
		},
	);
});

describe("dead-code advisory vs the cap (#3901)", () => {
	const issue = (file: string) => ({
		category: "export",
		kind: "function",
		name: "orphanPy",
		file,
		line: 1,
	});

	it.each(CELLS)(
		"$cell: a cut advisory is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-dead-code-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
				rig.scan.deadCode = [issue(edited)];

				const first = await endTurn(rig);
				expect(first.includes("orphanPy")).toBe(reached);

				clearFiller(rig, fillerFile);
				retireWorklist(rig);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("orphanPy")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("orphanPy");
			} finally {
				rig.cleanup();
			}
		},
	);

	it("does not re-offer a cut item the next scan no longer reports", async () => {
		const rig = makeRig("pi-lens-3901-dead-code-fresh-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
			rig.scan.deadCode = [issue(edited)];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.scan.deadCode = [];
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("orphanPy");
		} finally {
			rig.cleanup();
		}
	});
});

describe("call-graph impact advisory vs the cap (#3813)", () => {
	function graphWith(callee: string, callers: string[]): FunctionCallGraph {
		return {
			callees: new Map(),
			callers: new Map([[callee, new Set(callers)]]),
			edges: callers.map((callerKey) => ({
				callerKey,
				calleeKey: callee,
				weight: 1,
				evidenceCount: 1,
			})) as any,
			inDegree: new Map(),
			unresolvedRefs: 0,
			totalRefs: callers.length,
			coverage: { complete: true } as any,
			builtAt: new Date().toISOString(),
		};
	}

	it.each(CELLS)(
		"$cell: cut impact lines are re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-call-graph-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const edited = touch(rig, "src/core.ts");
				const caller = touch(rig, "src/caller.ts");
				rig.runtime.callGraph = graphWith(`${edited}:doThing`, [
					`${caller}:liveCaller`,
				]);

				const first = await endTurn(rig);
				expect(first.includes("liveCaller")).toBe(reached);

				clearFiller(rig, fillerFile);
				retireWorklist(rig);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("liveCaller")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("liveCaller");
			} finally {
				rig.cleanup();
			}
		},
	);
});
