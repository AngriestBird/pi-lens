/**
 * Contract of `pinPrivateLensHome` (#3721). The walk in
 * tests/clients/pi-lens-home-hermeticity.test.ts trusts the helper to be the one
 * spelling that yields a PRIVATE home and gives it back: a helper that pinned
 * the shared home, or left the pin set after `release()`, would turn every
 * driver file the walk clears into a leak of the pin itself (a later file in
 * the same worker would inherit a deleted home).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinPrivateLensHome } from "./private-lens-home.js";

const original = process.env.PI_LENS_HOME;

afterEach(() => {
	if (original === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = original;
});

describe("pinPrivateLensHome", () => {
	it("moves PI_LENS_HOME to a private child of the previous home, and release restores it and removes the directory", async () => {
		const shared = process.env.PI_LENS_HOME as string;
		const lens = pinPrivateLensHome("contract-a");
		expect(lens.home).not.toBe(shared);
		expect(path.dirname(lens.home)).toBe(shared);
		expect(process.env.PI_LENS_HOME).toBe(lens.home);

		fs.mkdirSync(lens.home, { recursive: true });
		fs.writeFileSync(path.join(lens.home, "latency.log"), "row\n");
		await lens.release();

		expect(process.env.PI_LENS_HOME).toBe(shared);
		expect(fs.existsSync(lens.home)).toBe(false);
	});

	it("two files in one worker get distinct homes, and an unset previous home is unset again after release", async () => {
		const first = pinPrivateLensHome("contract-b");
		const second = pinPrivateLensHome("contract-c");
		expect(second.home).not.toBe(first.home);
		await second.release();
		await first.release();

		delete process.env.PI_LENS_HOME;
		const lens = pinPrivateLensHome("contract-d");
		expect(path.basename(lens.home)).toMatch(/^pi-lens-contract-d-home-\d+$/);
		await lens.release();
		expect(process.env.PI_LENS_HOME).toBeUndefined();
	});
});
