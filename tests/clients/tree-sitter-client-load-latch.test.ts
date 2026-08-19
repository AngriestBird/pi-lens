/**
 * Regression test for #1592: `TreeSitterClient.init()` retried a dead
 * `import()`.
 *
 * `init()` calls `loadWebTreeSitter()` (clients/deps/web-tree-sitter.js),
 * which dynamically `import()`s the package via a resolved `file://` URL.
 * Node's ESM loader permanently memoizes a module record that threw during
 * EVALUATION: a later `import()` of the same URL replays the cached
 * rejection instead of re-attempting the load (the class this issue sweeps,
 * also documented in clients/lazy-import.ts and fixed for the analogous
 * ast-grep-napi loader in #1575/#1567).
 *
 * Pre-fix, `init()` only latched permanently (`wasmAborted`) for errors
 * matching the Emscripten "Aborted"/"abort()" signature
 * (`isTreeSitterWasmAbortError`). Any OTHER `loadWebTreeSitter()` rejection
 * left `initialized` false and `initPromise` cleared in the `finally`, so
 * the very next call to `init()` — and `TreeSitterClient.init()` is called
 * from `withTreeSitterRoot()` on every file parse — re-invoked
 * `loadWebTreeSitter()` again, replaying the identical cached rejection on
 * every parse for the rest of the process: a retry that looks like a retry
 * and structurally cannot be one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("TreeSitterClient.init() web-tree-sitter load latch (#1592)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("../../clients/deps/web-tree-sitter.js");
	});

	it("does not re-import after loadWebTreeSitter() rejects with a non-abort error", async () => {
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(
					new Error("Cannot find module '@types/web-tree-sitter'"),
				);
			},
		}));

		const { TreeSitterClient } = await import(
			"../../clients/tree-sitter-client.js"
		);
		const client = new TreeSitterClient();

		const first = await client.init();
		const second = await client.init();
		const third = await client.init();

		expect(first).toBe(false);
		expect(second).toBe(false);
		expect(third).toBe(false);
		// The bug: without a latch specific to this rejection, every call to
		// init() re-invokes loadWebTreeSitter() and replays the same cached
		// ESM rejection. Fixed behavior: exactly one attempt for the life of
		// this client.
		expect(loadCalls).toBe(1);
	});

	it("still latches on a load rejection classified as a wasm abort", async () => {
		// wasmAborted is unaffected by this fix — a genuine Emscripten abort
		// still latches via the existing reportWasmAbort path (unchanged
		// behavior, asserted here so the new latch doesn't shadow it).
		let loadCalls = 0;
		vi.doMock("../../clients/deps/web-tree-sitter.js", () => ({
			loadWebTreeSitter: () => {
				loadCalls += 1;
				return Promise.reject(new Error("Aborted(native code)"));
			},
		}));

		const { TreeSitterClient } = await import(
			"../../clients/tree-sitter-client.js"
		);
		const client = new TreeSitterClient();

		await client.init();
		await client.init();

		expect(loadCalls).toBe(1);
		expect(client.isAvailable()).toBe(false);
	});
});
