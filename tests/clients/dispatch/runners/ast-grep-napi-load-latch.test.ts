/**
 * Regression tests for #1567: the ast-grep napi load latch had no in-flight
 * dedupe and no session re-arm.
 *
 * `loadSg()` in clients/dispatch/runners/ast-grep-napi.ts guards the native
 * `@ast-grep/napi` addon load behind a module-level "attempted" flag. Two
 * real callers race for it — the per-edit fallback runner and the
 * session-start project scanner (clients/project-diagnostics/scanner.ts) —
 * and pre-fix, a second caller arriving while the first load was still
 * pending saw neither a cached module nor a set latch, so it kicked off a
 * REDUNDANT second `import()` of the native addon. Once a load failed for
 * any reason, the flag latched for the rest of the PROCESS, surviving every
 * session boundary — the #1266/#1490/#1497/#1535/#1536 shape.
 *
 * The fix shares one in-flight promise across callers, evicts it on settle
 * (#1536's pattern), and re-arms a genuine-failure verdict / live transient
 * cooldown at session_start via `resetAstGrepNapiLoadState()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ast-grep napi load latch (#1567)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("@ast-grep/napi");
		vi.doUnmock("../../../../clients/deps/ast-grep-napi.js");
	});

	it("dedupes a concurrent load race: two callers in flight trigger only one underlying load", async () => {
		// Mock the centralized deps accessor directly (rather than the raw npm
		// package) so the timing of the underlying load is fully controlled —
		// `loadAstGrepNapi()` in clients/deps/ast-grep-napi.ts is what `loadSg()`
		// actually calls.
		let loadCalls = 0;
		let resolveLoad: (value: unknown) => void = () => {};
		vi.doMock("../../../../clients/deps/ast-grep-napi.js", () => ({
			loadAstGrepNapi: () => {
				loadCalls += 1;
				return new Promise((resolve) => {
					resolveLoad = resolve;
				});
			},
		}));

		const mod = await import(
			"../../../../clients/dispatch/runners/ast-grep-napi.js"
		);

		// The per-edit fallback runner and the session-start scanner both call
		// loadSg() independently — simulate the race by calling it twice before
		// either settles.
		const first = mod.loadSg();
		const second = mod.loadSg();

		resolveLoad({ ts: { parse: vi.fn() } });
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(loadCalls).toBe(1);
		expect(firstResult).toBe(secondResult);
		expect(firstResult).toBeDefined();
	});

	it("re-arms a genuine-failure latch from a previous session so a fresh session retries", async () => {
		vi.doMock("@ast-grep/napi", () => {
			throw Object.assign(new Error("Cannot find module '@ast-grep/napi'"), {
				code: "MODULE_NOT_FOUND",
			});
		});

		const mod = await import(
			"../../../../clients/dispatch/runners/ast-grep-napi.js"
		);

		// Previous session: the addon load fails for a genuine reason and
		// latches.
		expect(await mod.loadSg()).toBeUndefined();
		expect(await mod.loadSg()).toBeUndefined();

		// A fresh session starts (session_start reset), and this time the
		// addon is actually loadable — e.g. a reinstall repaired it mid-host-
		// lifetime.
		mod.resetAstGrepNapiLoadState();
		vi.doUnmock("@ast-grep/napi");
		vi.doMock("@ast-grep/napi", () => ({ ts: { parse: vi.fn() } }));

		const result = await mod.loadSg();
		expect(result).toBeDefined();
	});

	it("retries a transient load failure after cooldown instead of latching for the session", async () => {
		vi.useFakeTimers();
		try {
			vi.doMock("@ast-grep/napi", () => {
				throw new Error("EMFILE: too many open files");
			});

			const mod = await import(
				"../../../../clients/dispatch/runners/ast-grep-napi.js"
			);

			expect(await mod.loadSg()).toBeUndefined();

			// Still cooling down: a second call in the same session gets no
			// retry yet.
			expect(await mod.loadSg()).toBeUndefined();

			vi.doUnmock("@ast-grep/napi");
			vi.doMock("@ast-grep/napi", () => ({ ts: { parse: vi.fn() } }));

			// Advance past the transient cooldown window without a session
			// boundary — a transient failure must recover on its own.
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await mod.loadSg()).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
