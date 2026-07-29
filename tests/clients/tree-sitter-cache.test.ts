import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeCache } from "../../clients/tree-sitter-cache.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

// web-tree-sitter Trees hold WASM-heap memory that JS GC does NOT reclaim — the
// cache must call tree.delete() on every removal or it leaks (#417). These use
// fake trees with a delete() spy to assert exactly-once release on each path.
// Paths are virtual: set()/get() stat the file for mtime and tolerate ENOENT.

function fakeTree() {
	return { delete: vi.fn(), rootNode: { type: "program" } };
}

async function flushRetiredTrees(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("TreeCache frees WASM trees on removal (#417)", () => {
	it("frees the oldest tree after active consumers can resume", async () => {
		const cache = new TreeCache(2);
		const a = fakeTree();
		const b = fakeTree();
		const c = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.set("c.ts", "c", "typescript", c); // evicts oldest (a)

		expect(a.delete).not.toHaveBeenCalled();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).not.toHaveBeenCalled();
		expect(c.delete).not.toHaveBeenCalled();
	});

	it("frees the superseded tree when re-parsing the same file (same key)", async () => {
		const cache = new TreeCache(10);
		const old = fakeTree();
		const fresh = fakeTree();
		cache.set("x.ts", "v1", "typescript", old);
		cache.set("x.ts", "v2", "typescript", fresh); // overwrite same key

		await flushRetiredTrees();
		expect(old.delete).toHaveBeenCalledTimes(1);
		expect(fresh.delete).not.toHaveBeenCalled();
	});

	it("frees every tree on clear()", async () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.clear();

		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("does NOT free the tree when content changed (a reader may still hold it)", () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set("a.ts", "original", "typescript", a);
		// Different content ⇒ cache miss, but the entry is retained until the next
		// set() replaces it — it must not be deleted out from under a live reader.
		const hit = cache.get("a.ts", "changed content", "typescript");

		expect(hit).toBeNull();
		expect(a.delete).not.toHaveBeenCalled();
	});

	it("never double-frees an already-evicted tree", async () => {
		const cache = new TreeCache(1);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a); // a cached
		cache.set("b.ts", "b", "typescript", b); // evicts a → a freed once
		cache.clear(); // frees b only; a is gone

		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when the file changed on disk (mtime bump)", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-mtime-");
		cleanups.push(env.cleanup);
		const src = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "m.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		// Same content (hash matches) but a newer mtime ⇒ get() must invalidate+free.
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);

		expect(cache.get(file, src, "typescript")).toBeNull();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when the file was deleted on disk", async () => {
		const env = setupTestEnvironment("pi-lens-tccache-del-");
		cleanups.push(env.cleanup);
		const src = "export const y = 2;\n";
		const file = createTempFile(env.tmpDir, "d.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		fs.rmSync(file);

		expect(cache.get(file, src, "typescript")).toBeNull();
		await flushRetiredTrees();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("survives a tree whose delete() throws (dead/aborted runtime)", async () => {
		const cache = new TreeCache(1);
		const boom = {
			delete: vi.fn(() => {
				throw new Error("Aborted()");
			}),
		};
		const next = fakeTree();
		cache.set("a.ts", "a", "typescript", boom);
		expect(() => cache.set("b.ts", "b", "typescript", next)).not.toThrow();
		await flushRetiredTrees();
		expect(boom.delete).toHaveBeenCalledTimes(1);
	});
});

describe("TreeCache statistics (#675)", () => {
	it("tracks cold, content-changed, mtime, and stat-failure misses", () => {
		const env = setupTestEnvironment("pi-lens-tccache-stats-");
		cleanups.push(env.cleanup);
		const source = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "stats.ts", source);
		const cache = new TreeCache(10);

		expect(cache.get(file, source, "typescript")).toBeNull();
		cache.set(file, source, "typescript", fakeTree());
		expect(cache.get(file, source, "typescript")).not.toBeNull();
		expect(cache.get(file, `${source}// changed`, "typescript")).toBeNull();

		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);
		expect(cache.get(file, source, "typescript")).toBeNull();

		const deleted = createTempFile(env.tmpDir, "deleted.ts", source);
		cache.set(deleted, source, "typescript", fakeTree());
		fs.rmSync(deleted);
		expect(cache.get(deleted, source, "typescript")).toBeNull();

		expect(cache.getStats()).toMatchObject({
			lookups: 5,
			hits: 1,
			misses: 4,
			coldMisses: 1,
			contentChangedMisses: 1,
			mtimeMisses: 1,
			statFailedMisses: 1,
		});
	});

	it("distinguishes a same-content reload after capacity eviction", () => {
		const cache = new TreeCache(1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			lookups: 1,
			misses: 1,
			coldMisses: 0,
			capacityMisses: 1,
			evictions: 1,
		});
	});

	it("drops eviction ghosts on clear() so the next miss reads as cold", () => {
		const cache = new TreeCache(1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.clear();

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 1,
			capacityMisses: 0,
		});
	});

	it("normalizes path separators in cache keys", () => {
		const cache = new TreeCache(2);
		cache.set("dir\\a.ts", "a", "typescript", fakeTree());

		// Same file, other separator: the key MATCHES (so the miss is the on-disk
		// stat failing, not a cold lookup against a different key).
		expect(cache.get("dir/a.ts", "a", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 0,
			statFailedMisses: 1,
		});
	});

	it("bounds eviction history and reports dropped keys", () => {
		const cache = new TreeCache(1, false, 1);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.set("c.ts", "c", "typescript", fakeTree());

		expect(cache.get("a.ts", "a", "typescript")).toBeNull();
		expect(cache.get("b.ts", "b", "typescript")).toBeNull();
		expect(cache.getStats()).toMatchObject({
			coldMisses: 1,
			capacityMisses: 1,
			ghostHistoryDrops: 1,
		});
	});

	it("reports UTF-8 resident source bytes", () => {
		const cache = new TreeCache(2);
		cache.set("unicode.ts", "é\n", "typescript", fakeTree());

		expect(cache.getStats().totalBytes).toBe(3);
	});

	it("tracks replacement and clear operations", () => {
		const cache = new TreeCache(2);
		cache.set("a.ts", "a", "typescript", fakeTree());
		cache.set("b.ts", "b", "typescript", fakeTree());
		cache.set("a.ts", "updated", "typescript", fakeTree());
		cache.clear();

		expect(cache.getStats()).toMatchObject({
			sets: 3,
			replacements: 1,
			clears: 1,
			size: 0,
		});
	});
});
