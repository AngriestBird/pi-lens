/**
 * The callback-scoped companion `withGlobalConfig` (#4937 remainder 1): the
 * file it writes, the variable it points at for one callback, and the restore
 * that runs even when the callback throws.
 *
 * Recurrence this guards: index-4682, index-4687, index-4723 and the release-qa
 * row each carried a private copy of this shape. A copy whose restore does not
 * run leaks one case's global config path into every later case in the worker,
 * the leak the env-restore sweep (#4589) exists to stop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";
import { withGlobalConfig } from "./global-config.js";

const SENTINEL = "/pi-lens-global-config-test/sentinel.json";
let original: string | undefined;
let dir: string;

beforeEach(() => {
	original = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_CONFIG_PATH = SENTINEL;
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-with-global-config-"));
});

afterEach(() => {
	if (original === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = original;
	removeTempDirSync(dir);
});

describe("withGlobalConfig", () => {
	it("writes the config to the file it names, points the variable there in the body, and restores it after", async () => {
		const file = path.join(dir, "nested", "config.json");
		let inside: string | undefined;
		const result = await withGlobalConfig(
			file,
			{ lsp: { enabled: false } },
			() => {
				inside = process.env.PI_LENS_CONFIG_PATH;
				return "done";
			},
		);
		expect(result).toBe("done");
		expect(inside).toBe(file);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
			lsp: { enabled: false },
		});
		expect(process.env.PI_LENS_CONFIG_PATH).toBe(SENTINEL);
	});

	it("restores the variable and rethrows when the body throws", async () => {
		const file = path.join(dir, "config.json");
		await expect(
			withGlobalConfig(file, {}, () => {
				throw new Error("body failed");
			}),
		).rejects.toThrow("body failed");
		expect(process.env.PI_LENS_CONFIG_PATH).toBe(SENTINEL);
	});

	it("unsets the variable afterwards when it was unset before the call", async () => {
		delete process.env.PI_LENS_CONFIG_PATH;
		const file = path.join(dir, "config.json");
		await withGlobalConfig(file, {}, () => undefined);
		expect(process.env.PI_LENS_CONFIG_PATH).toBeUndefined();
	});
});
