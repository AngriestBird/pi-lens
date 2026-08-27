import { describe, it, expect } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";

// The store caps file records at 1024 and exempts the 16 most recently
// dispatched paths from eviction.
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
		for (const p of batchPaths("walk")) store.setFileFact(p, "file.content", "");

		expect(store.getFileFact(active, "file.content")).toBe("const x = 1;");
	});

	it("bounds the pin set — an old dispatch cannot pin a record forever", () => {
		const store = new FactStore();
		const dispatched = batchPaths("dispatched", MAX_PINNED * 2);
		for (const p of dispatched) {
			store.clearFileFactsFor(p);
			store.setFileFact(p, "file.content", "x");
		}

		for (const p of batchPaths("walk")) store.setFileFact(p, "file.content", "");

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
		for (const p of batchPaths("walk")) store.setFileFact(p, "file.content", "");

		expect(store.hasFileFact(active, "file.content")).toBe(false);
	});
});
