/**
 * #1570: `x ??= import(...)`-style promise memos cache a REJECTED promise for
 * the process lifetime — one transient module-load failure (EMFILE, a
 * momentary fs error) permanently poisons the lazy import for every later
 * caller. `createLazyImport` is the shared eviction-on-rejection helper that
 * replaces the five hand-rolled `??= import(...)` sites.
 */
import { describe, expect, it, vi } from "vitest";
import { createLazyImport } from "../../clients/lazy-import.js";

describe("createLazyImport (#1570)", () => {
	it("retries the loader after a rejection instead of replaying it forever", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("EMFILE: transient fs error"))
			.mockResolvedValueOnce({ ok: true });

		const lazy = createLazyImport(load);

		await expect(lazy.get()).rejects.toThrow("EMFILE: transient fs error");
		await expect(lazy.get()).resolves.toEqual({ ok: true });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("memoizes a successful load — a later call does not re-invoke the loader", async () => {
		const load = vi.fn().mockResolvedValue({ ok: true });
		const lazy = createLazyImport(load);

		const first = await lazy.get();
		const second = await lazy.get();

		expect(first).toBe(second);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent callers onto the same in-flight promise", async () => {
		let resolveLoad: (value: { ok: true }) => void = () => {};
		const load = vi.fn(
			() =>
				new Promise<{ ok: true }>((resolve) => {
					resolveLoad = resolve;
				}),
		);
		const lazy = createLazyImport(load);

		const a = lazy.get();
		const b = lazy.get();
		// `get()` defers the loader call by one microtask (see the
		// synchronous-throw contract test below), so `load` has not run yet at
		// this point — wait for it before resolving.
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		resolveLoad({ ok: true });
		await Promise.all([a, b]);

		expect(load).toHaveBeenCalledTimes(1);
	});

	it("resetForTests drops the memo even after a successful load", async () => {
		const load = vi.fn().mockResolvedValue({ ok: true });
		const lazy = createLazyImport(load);

		await lazy.get();
		lazy.resetForTests();
		await lazy.get();

		expect(load).toHaveBeenCalledTimes(2);
	});

	it("returns a rejected promise instead of throwing, even if the loader throws synchronously", () => {
		const load = vi.fn(() => {
			throw new Error("sync boom");
		});
		const lazy = createLazyImport(load);

		expect(() => lazy.get()).not.toThrow();
		return expect(lazy.get()).rejects.toThrow("sync boom");
	});
});
