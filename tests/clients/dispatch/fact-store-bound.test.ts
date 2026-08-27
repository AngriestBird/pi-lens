import { afterEach, describe, it, expect } from "vitest";
import {
	getDegradationSummary,
	recordDegradationOnce,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	FactStore,
	setFactStoreEvictionReporter,
} from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

// fact-store emits capacity-eviction telemetry through an injected reporter
// (it stays an import leaf; integration.ts wires the real one). Install the
// SAME reporter production uses so these tests exercise the real ledger path.
function installProductionEvictionReporter(): void {
	setFactStoreEvictionReporter((reason) => {
		recordDegradationOnce({
			kind: "fact-store-capacity-eviction",
			subject: "session-fact-store",
			reason,
		});
	});
}

afterEach(() => setFactStoreEvictionReporter(undefined));

// The store caps file records at 1024 and exempts in-flight dispatches from
// eviction. A dispatch pins its file at start and releases it at completion;
// the pin set is bounded at 16 as a backstop against a leaked pin.
const MAX_RECORDS = 1024;
const MAX_PINNED = 16;
const BATCH = 2000;

function batchPaths(prefix: string, count = BATCH): string[] {
	return Array.from({ length: count }, (_, i) => `/repo/src/${prefix}-${i}.ts`);
}

function retained(store: FactStore, paths: string[]): number {
	return paths.filter((p) => store.hasFileFact(p, "file.content")).length;
}

describe("FactStore file-fact bound (#2240)", () => {
	it("caps distinct file records so a large batch cannot exhaust the heap", () => {
		const store = new FactStore();
		const paths = batchPaths("batch");
		store.setSessionFact("session.toolCache.biome", true);

		for (const p of paths) store.setFileFact(p, "file.content", "x");

		expect(retained(store, paths)).toBeLessThanOrEqual(
			MAX_RECORDS + MAX_PINNED,
		);
		expect(store.hasFileFact(paths[0], "file.content")).toBe(false);
		expect(store.hasFileFact(paths[BATCH - 1], "file.content")).toBe(true);
		// Eviction is capacity-only — session baselines and tool caches stay.
		expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("evicts least-recently-used records, keeping the ones still being read", () => {
		const store = new FactStore();
		const paths = batchPaths("lru");
		for (const p of paths.slice(0, MAX_RECORDS)) {
			store.setFileFact(p, "file.content", "x");
		}
		// Re-read the oldest record: an LRU touch must move it off the victim end.
		expect(store.getFileFact(paths[0], "file.content")).toBe("x");

		for (const p of paths.slice(MAX_RECORDS)) {
			store.setFileFact(p, "file.content", "x");
		}

		expect(store.hasFileFact(paths[0], "file.content")).toBe(true);
		expect(store.hasFileFact(paths[1], "file.content")).toBe(false);
	});

	it("never evicts the file whose dispatch is in flight", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		// What every per-file dispatch does before its providers run.
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		// The fire-and-forget blast-radius build walks the whole project against
		// this same store while the dispatch is still running.
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.getFileFact(active, "file.content")).toBe("const x = 1;");
	});

	it("bounds the pin set — an old dispatch cannot pin a record forever", () => {
		const store = new FactStore();
		const dispatched = batchPaths("dispatched", MAX_PINNED * 2);
		for (const p of dispatched) {
			store.clearFileFactsFor(p);
			store.setFileFact(p, "file.content", "x");
		}

		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.hasFileFact(dispatched[0], "file.content")).toBe(false);
		expect(
			store.hasFileFact(dispatched[dispatched.length - 1], "file.content"),
		).toBe(true);
	});

	it("clearAll releases the pins with the records", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		store.clearAll();

		store.setFileFact(active, "file.content", "const x = 1;");
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.hasFileFact(active, "file.content")).toBe(false);
	});

	// #2243 item 2: the pin is released at dispatch END, so the pin set tracks
	// dispatches actually in flight — not the last 16 files touched. A file whose
	// dispatch is still running survives even after 16 LATER dispatches complete.
	it("a completed dispatch releases its pin, so 16 later completed dispatches keep an in-flight file", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		// The in-flight dispatch: begins, but has not settled.
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		// 16 later dispatches that each BEGIN and SETTLE.
		for (const p of batchPaths("later", MAX_PINNED)) {
			store.clearFileFactsFor(p);
			store.setFileFact(p, "file.content", "y");
			store.endDispatchFor(p);
		}

		// The fire-and-forget project walk floods the store.
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.getFileFact(active, "file.content")).toBe("const x = 1;");
	});

	// #2243: dropFileFacts clears without pinning, so a scan's own store keeps
	// the capacity cap effective. clearFileFactsFor pins; dropFileFacts must not.
	it("dropFileFacts does not pin — a dropped file stays evictable", () => {
		const store = new FactStore();
		const viaDrop = "/repo/src/via-drop.ts";
		const viaClear = "/repo/src/via-clear.ts";
		store.dropFileFacts(viaDrop);
		store.setFileFact(viaDrop, "file.content", "d");
		store.clearFileFactsFor(viaClear);
		store.setFileFact(viaClear, "file.content", "c");

		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		// clearFileFactsFor pinned viaClear (in flight) → survives.
		expect(store.getFileFact(viaClear, "file.content")).toBe("c");
		// dropFileFacts did not pin viaDrop → the walk evicts it.
		expect(store.hasFileFact(viaDrop, "file.content")).toBe(false);
	});

	// #2243 item 4: the cap evicts silently, and the victim can be a fact a live
	// dispatch still needs. Record ONE bounded degradation on the first capacity
	// eviction per session, stamped with the evicted path, re-arming per session.
	it("records one capacity-eviction degradation per session, naming the evicted path", () => {
		resetDegradationLedger();
		installProductionEvictionReporter();
		const store = new FactStore();
		const paths = batchPaths("evict");
		for (const p of paths) store.setFileFact(p, "file.content", "x");

		const find = () =>
			getDegradationSummary().find(
				(g) => g.kind === "fact-store-capacity-eviction",
			);
		const group = find();
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		// One record per session (constant subject); the reason names the FIRST
		// evicted path (oldest inserted).
		expect(group?.latestReasons.at(-1)?.subject).toBe("session-fact-store");
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			normalizeMapKey(paths[0]),
		);

		// Further evictions in the same session do not add a second record.
		for (const p of batchPaths("evict2"))
			store.setFileFact(p, "file.content", "x");
		expect(find()?.count).toBe(1);

		// A new session (ledger re-arm) records again.
		resetDegradationLedger();
		const store2 = new FactStore();
		for (const p of batchPaths("evict3"))
			store2.setFileFact(p, "file.content", "x");
		expect(find()?.count).toBe(1);
	});

	// fact-store must stay an import leaf: it emits eviction telemetry only
	// through the injected reporter, never by importing the ledger directly
	// (that re-enters the safe-spawn ↔ degradation-ledger cycle).
	it("emits capacity eviction through the injected reporter", () => {
		const reasons: string[] = [];
		setFactStoreEvictionReporter((reason) => reasons.push(reason));
		const store = new FactStore();
		for (const p of batchPaths("emit"))
			store.setFileFact(p, "file.content", "x");
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons[0]).toContain("exceeded");
	});
});
