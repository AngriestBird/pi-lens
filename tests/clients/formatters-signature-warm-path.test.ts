/**
 * #1603 — `formatterConfigSignature` ran BEFORE the cache check in
 * `getFormattersForFile`, and its `findUp` walk probed every one of
 * `FORMATTER_CONFIG_FILES`' ~60 names with its own `fs.access` call at every
 * ancestor directory. That cost scaled with the candidate list's length (a
 * measured 41% growth as #1596 grew it 44→60 entries) and ran unconditionally
 * on every call, including a fully warm cache hit that never needed it.
 *
 * Fixed by having `findUp` read each ancestor directory once (`fs.readdir`)
 * and check membership in-memory, instead of probing each candidate name with
 * its own `fs.access`. The walk still runs on every call — so a config file
 * created after the first call keeps invalidating the cache exactly as
 * before (#1572/#1596) — but its cost no longer depends on how many names
 * the candidate list holds.
 *
 * This FAILS against pre-fix code: `fs.access` is called once per
 * (ancestor directory × candidate filename) on every call, so a warm repeat
 * call for an already-cached extension still fires a large, nonzero number
 * of `access` probes.
 */

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		access: vi.fn(actual.access),
		readdir: vi.fn(actual.readdir),
	};
});

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFormatterRuntimeState,
	getFormattersForFile,
} from "../../clients/formatters.js";
import { setupTestEnvironment } from "./test-utils.js";

const accessMock = vi.mocked(fsp.access);
const readdirMock = vi.mocked(fsp.readdir);

let tmpDir: string;
let cleanup: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-fmt-sig-"));
	accessMock.mockClear();
	readdirMock.mockClear();
});

afterEach(() => {
	clearFormatterRuntimeState();
	cleanup();
});

describe("formatterConfigSignature warm-cache cost (#1603)", () => {
	it("a repeat call for an already-cached extension makes no per-config-name access probes", async () => {
		// An extension no formatter claims: `matching` is empty, so the only
		// filesystem work `getFormattersForFile` does at all is the unconditional
		// `formatterConfigSignature` walk — isolating exactly the cost this issue
		// is about.
		const filePath = path.join(tmpDir, "index.zzznotarealext");

		await getFormattersForFile(filePath, tmpDir);
		accessMock.mockClear();
		readdirMock.mockClear();

		await getFormattersForFile(filePath, tmpDir);

		expect(accessMock).not.toHaveBeenCalled();
		// One readdir per ancestor directory — bounded by directory depth, not
		// by however many names FORMATTER_CONFIG_FILES holds.
		expect(readdirMock.mock.calls.length).toBeGreaterThan(0);
		expect(readdirMock.mock.calls.length).toBeLessThan(20);
	});
});
