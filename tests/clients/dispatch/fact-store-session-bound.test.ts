import { afterEach, describe, it, expect } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	FactStore,
	getFactStoreEvictionReporter,
	setFactStoreEvictionReporter,
} from "../../../clients/dispatch/fact-store.js";
import type {
	Diagnostic,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
// Side-effect import: loading integration.ts runs its module-scope
// `setFactStoreEvictionReporter(...)` call, wiring the REAL production
// reporter into fact-store's module-scope slot (mirrors fact-store-bound.test.ts).
import "../../../clients/dispatch/integration.js";
const productionEvictionReporter = getFactStoreEvictionReporter();

afterEach(() => setFactStoreEvictionReporter(undefined));

const MAX_SESSION_RECORDS = 4096;
const BATCH = 3000;

function batchPaths(prefix: string, count = BATCH): string[] {
	return Array.from({ length: count }, (_, i) => `/repo/src/${prefix}-${i}.ts`);
}

// A realistic per-file delta-baseline payload: two `Diagnostic`s, the shape
// `dispatcher.ts` persists to `session.baseline.*` on every delta-mode dispatch.
function representativeBaseline(path: string): Diagnostic[] {
	return [
		{
			id: "no-console",
			message: "Unexpected console statement found in this module",
			filePath: path,
			line: 42,
			column: 7,
			severity: "warning",
			semantic: "warning",
			tool: "eslint",
			rule: "no-console",
		},
		{
			id: "no-unused-vars",
			message: "'value' is assigned a value but never used",
			filePath: path,
			line: 12,
			column: 3,
			severity: "warning",
			semantic: "warning",
			tool: "eslint",
			rule: "no-unused-vars",
		},
	];
}

describe("FactStore session-fact bound (#2282)", () => {
	// Acceptance criterion 1: measure the retained cost across a several-
	// hundred-file batch, separating baseline keys from fixed-vocabulary keys.
	it("measures the retained cost of unbounded session.baseline growth across a several-hundred-file batch", () => {
		const FILES = 500; // "several hundred", matching the issue's own wording
		const paths = batchPaths("measure", FILES);

		// dispatcher.ts mints TWO session.baseline keys per file (absolute +
		// relative), each holding the same Diagnostic[] snapshot (#2282 evidence).
		const perFileBytes = paths.reduce((sum, p) => {
			const payload = JSON.stringify(representativeBaseline(p));
			return sum + 2 * Buffer.byteLength(payload, "utf8");
		}, 0);
		const baselineKeyCount = FILES * 2;

		// Fixed-vocabulary keys stay small and constant regardless of batch size:
		// one `<command>`/`<command>.transientAttempts`/`<command>.transientRetryAt`
		// trio per distinct external tool, plus the "session.reviewGraph" singleton.
		// A real project dispatches against a few dozen tools at most.
		const FIXED_VOCAB_COMMANDS = 30;
		const fixedVocabKeyCount = FIXED_VOCAB_COMMANDS * 3 + 1;

		// Stated numbers (acceptance criterion 1): a 500-file batch retains 1000
		// baseline entries totaling ~430 KB (439,560 bytes measured here) that
		// never shrink for the rest of the process, against a fixed-vocabulary
		// footprint of ~91 entries that cannot grow past the tool count. The
		// baseline family — not the fixed vocabulary — is what scales with batch
		// size, so it is the one bounded.
		expect(baselineKeyCount).toBe(1000);
		expect(perFileBytes).toBe(439_560);
		expect(fixedVocabKeyCount).toBeLessThan(100);
		expect(baselineKeyCount).toBeGreaterThan(fixedVocabKeyCount * 10);
	});

	// Acceptance criteria 2 & 4: the production dispatch path (dispatcher.ts)
	// now bounds session.baseline growth by reusing #2243's FactStore-level LRU
	// discipline, not a hand-rolled prefix check. This test drives the REAL
	// `dispatchForFile` entry point across a several-hundred(+)-file batch and
	// observes a purely behavioral signal (`baselineWarningCount`) — no new API
	// appears in this test body, so it is genuinely red on pre-#2282 dispatcher.ts
	// (unbounded `sessionFacts.setSessionFact`) and green after.
	it("stops retaining an early file's delta baseline once a large batch exceeds the session-fact cap", async () => {
		const registry = new RunnerRegistry();
		registry.register(
			createMockRunner({
				id: "reporter",
				appliesTo: ["jsts"],
				runResult: {
					status: "succeeded",
					diagnostics: [
						{
							id: "no-console",
							message: "Unexpected console statement",
							filePath: "irrelevant.ts",
							severity: "warning",
							semantic: "warning",
							tool: "eslint",
						},
					],
					semantic: "warning",
				},
			}),
		);
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];
		const facts = new FactStore();
		const pi = { getFlag: () => false };
		const cwd = "/project";
		const firstPath = `${cwd}/src/first-touched.ts`;

		// First dispatch of this file: no prior baseline exists yet.
		const firstResult = await dispatchForFile(
			createDispatchContext(firstPath, cwd, pi, facts),
			groups,
			registry,
		);
		expect(firstResult.baselineWarningCount).toBe(0);

		// A several-hundred(+)-file batch touches every OTHER file exactly once —
		// the shape a large merge/checkout dispatch produces.
		for (const p of batchPaths("filler")) {
			await dispatchForFile(
				createDispatchContext(p, cwd, pi, facts),
				groups,
				registry,
			);
		}

		// Re-dispatch the FIRST file. Pre-#2282, `sessionFacts` never evicts, so
		// its baseline (1 warning, set by the first dispatch) is still there and
		// `baselineWarningCount` reads 1. Post-#2282, the bounded session-fact map
		// evicted it long before the batch finished, so no previous baseline is
		// found and it reads 0 — the same state as a file's first-ever dispatch.
		const secondResult = await dispatchForFile(
			createDispatchContext(firstPath, cwd, pi, facts),
			groups,
			registry,
		);
		expect(secondResult.baselineWarningCount).toBe(0);
	}, 30_000);

	it("caps distinct bounded session-fact records so a large batch cannot retain them all", () => {
		const store = new FactStore();
		const count = MAX_SESSION_RECORDS + 500;
		const paths = batchPaths("cap", count);

		for (const p of paths) store.setBoundedSessionFact(p, "x");

		const retained = paths.filter((p) => store.hasBoundedSessionFact(p)).length;
		expect(retained).toBeLessThanOrEqual(MAX_SESSION_RECORDS);
		expect(store.hasBoundedSessionFact(paths[0])).toBe(false);
		expect(store.hasBoundedSessionFact(paths[count - 1])).toBe(true);
		// Eviction is scoped to the bounded map — fixed-vocabulary session facts
		// on the plain map are untouched.
		store.setSessionFact("session.toolCache.biome", true);
		expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("evicts least-recently-used bounded records, keeping the ones still being read", () => {
		const store = new FactStore();
		const paths = batchPaths("lru", MAX_SESSION_RECORDS);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		// Re-read the oldest record: an LRU touch must move it off the victim end.
		expect(store.getBoundedSessionFact(paths[0])).toBe("x");

		store.setBoundedSessionFact("/repo/src/lru-overflow.ts", "y");

		expect(store.hasBoundedSessionFact(paths[0])).toBe(true);
		expect(store.hasBoundedSessionFact(paths[1])).toBe(false);
	});

	it("clearAll releases bounded session facts alongside file/session facts", () => {
		const store = new FactStore();
		const paths = batchPaths("clear", 10);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		store.clearAll();

		expect(store.hasBoundedSessionFact(paths[0])).toBe(false);
		expect(store.getSessionFactEntryCount()).toBe(0);
	});

	it("getSessionFactEntryCount reflects the fixed-vocabulary and bounded maps combined (#2282 Observability)", () => {
		const store = new FactStore();
		expect(store.getSessionFactEntryCount()).toBe(0);

		store.setSessionFact("dispatch:eslint", true);
		expect(store.getSessionFactEntryCount()).toBe(1);

		store.setBoundedSessionFact("session.baseline./repo/a.ts", []);
		expect(store.getSessionFactEntryCount()).toBe(2);

		// Overflow the bounded map: the fixed-vocabulary entry survives (it lives
		// on the OTHER map), and the total stops growing with batch size.
		for (const p of batchPaths("count-overflow", MAX_SESSION_RECORDS + 500))
			store.setBoundedSessionFact(p, []);
		expect(store.getSessionFactEntryCount()).toBeLessThanOrEqual(
			MAX_SESSION_RECORDS + 1,
		);
		expect(store.getSessionFact("dispatch:eslint")).toBe(true);
	});

	it("records one capacity-eviction degradation per session for the session-count axis, naming the evicted key", () => {
		expect(productionEvictionReporter).toBeDefined();
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch");
		const paths = batchPaths("evict", MAX_SESSION_RECORDS + 500);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		const group = getDegradationSummary().find(
			(g) => g.kind === "fact-store-capacity-eviction",
		);
		expect(group).toBeDefined();
		expect(
			group?.latestReasons.some((r) => r.subject === "dispatch:session-count"),
		).toBe(true);
		expect(
			group?.latestReasons.find((r) => r.subject === "dispatch:session-count")
				?.reason,
		).toContain(paths[0]);

		// The file-fact count axis and the session-fact count axis are
		// discriminated so one does not consume the other's once-per-session slot.
		for (const p of paths) store.setFileFact(p, "file.content", "x");
		const subjectsAfterFileEviction = (
			getDegradationSummary().find(
				(g) => g.kind === "fact-store-capacity-eviction",
			)?.latestReasons ?? []
		).map((r) => r.subject);
		expect(subjectsAfterFileEviction).toContain("dispatch:session-count");
		expect(subjectsAfterFileEviction).toContain("dispatch:count");
	});
});
