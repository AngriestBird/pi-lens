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
import { useConfigPath, withGlobalConfig } from "./global-config.js";

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

/**
 * The path setter `useConfigPath` (#4937 remainder 1, round 2): it sets or
 * unsets `PI_LENS_CONFIG_PATH`, optionally writes the file verbatim, and owns
 * the restore, so a loader test whose SUBJECT is the path (absent file,
 * explicit file, default under HOME, malformed text, unset variable) holds no
 * inline save and restore.
 *
 * Recurrence this guards: nine loader files each carried a private
 * save-in-beforeEach, restore-in-afterEach pair for this variable. A
 * restore-only registration reds the env-restore sweep (#4589) while the file
 * still assigns the variable, so the pair could not move until the setter owned
 * the write too. The cases below run in file order: the first leaves the
 * variable changed, the next observes what the scope's restore put back.
 */

/** Run `register` with the variable at `value` (or unset), then put it back. */
function registerWith<T>(value: string | undefined, register: () => T): T {
	const saved = process.env.PI_LENS_CONFIG_PATH;
	if (value === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = value;
	try {
		return register();
	} finally {
		if (saved === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = saved;
	}
}

const COLLECTED_VALUE = "/pi-lens-global-config-test/collected.json";

/**
 * Records the variable as it stands once the scope's own restore has run.
 * Vitest runs `afterEach` hooks of one scope in reverse registration order, so
 * the observer is registered BEFORE `useConfigPath()` and runs after its
 * restore. The file-level `beforeEach` rewrites the variable to the sentinel
 * before every case, which is why the next test cannot be the observer.
 */
function observeAfterRestore(): { value: () => string | undefined } {
	let seen: string | undefined = "never observed";
	afterEach(() => {
		seen = process.env.PI_LENS_CONFIG_PATH;
	});
	return { value: () => seen };
}

describe("useConfigPath restores a variable that was set when the scope was collected", () => {
	const observed = observeAfterRestore();
	const setConfigPath = registerWith(COLLECTED_VALUE, () => useConfigPath());

	it("points the variable at the file it is given, writing nothing for an absent file", () => {
		const absent = path.join(dir, "absent", "config.json");
		setConfigPath(absent);
		expect(process.env.PI_LENS_CONFIG_PATH).toBe(absent);
		expect(fs.existsSync(absent)).toBe(false);
	});

	it("put the collection-time value back after that test", () => {
		expect(observed.value()).toBe(COLLECTED_VALUE);
	});

	it("unsets the variable when it is given undefined", () => {
		setConfigPath(undefined);
		expect(process.env.PI_LENS_CONFIG_PATH).toBeUndefined();
	});
});

describe("useConfigPath restores a variable that was unset when the scope was collected", () => {
	const observed = observeAfterRestore();
	const setConfigPath = registerWith(undefined, () => useConfigPath());

	it("sets the variable inside the test", () => {
		setConfigPath(path.join(dir, "config.json"));
		expect(process.env.PI_LENS_CONFIG_PATH).toBeDefined();
	});

	it("unset the variable again after that test", () => {
		expect(observed.value()).toBeUndefined();
	});
});

describe("useConfigPath contents", () => {
	const setConfigPath = useConfigPath();

	it("writes the given text verbatim, malformed JSON included, creating the directory", () => {
		const file = path.join(dir, "deep", "nested", "config.json");
		setConfigPath(file, "{ not json");
		expect(process.env.PI_LENS_CONFIG_PATH).toBe(file);
		expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
	});
});
