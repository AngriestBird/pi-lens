/**
 * #1603 — warm formatter selection must not poll configuration files.
 *
 * Config changes are invalidated by the write-result seam. The cold signature
 * walk still uses real filesystem state to discover the initial config set.
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
	_findUpForTests,
	clearFormatterRuntimeState,
	getFormattersForFile,
	invalidateFormatterCacheForPath,
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
	it("does no filesystem work on a warm selection hit", async () => {
		const filePath = path.join(tmpDir, "index.zzznotarealext");

		await getFormattersForFile(filePath, tmpDir);
		const coldReaddirCount = readdirMock.mock.calls.length;
		expect(coldReaddirCount).toBeGreaterThan(0);
		accessMock.mockClear();
		readdirMock.mockClear();

		await getFormattersForFile(filePath, tmpDir);

		expect(accessMock).not.toHaveBeenCalled();
		expect(readdirMock).not.toHaveBeenCalled();
	});

	it("shares the cold signature walk across concurrent cwd lookups", async () => {
		const firstFile = path.join(tmpDir, "first.zzznotarealext");
		await getFormattersForFile(firstFile, tmpDir);
		const coldReaddirCount = readdirMock.mock.calls.length;
		expect(coldReaddirCount).toBeGreaterThan(0);

		clearFormatterRuntimeState();
		readdirMock.mockClear();
		await Promise.all([
			getFormattersForFile(firstFile, tmpDir),
			getFormattersForFile(path.join(tmpDir, "second.zzzotherext"), tmpDir),
		]);

		expect(readdirMock.mock.calls.length).toBe(coldReaddirCount);
	});

	it("scales with matched candidates, not the candidate-list size", async () => {
		const ancestor = path.join(tmpDir, "project");
		const sourceDir = path.join(ancestor, "src");
		const nested = path.join(sourceDir, "deep");
		await fsp.mkdir(nested, { recursive: true });
		await fsp.writeFile(path.join(sourceDir, "real.config"), "ok\n");

		const small = await _findUpForTests(["real.config"], nested, ancestor);
		const smallAccesses = accessMock.mock.calls.length;
		const smallReads = readdirMock.mock.calls.length;
		expect(small).toEqual([path.join(sourceDir, "real.config")]);

		accessMock.mockClear();
		readdirMock.mockClear();
		const large = await _findUpForTests(
			[
				"real.config",
				"missing-a.config",
				"missing-b.config",
				"missing-c.config",
			],
			nested,
			ancestor,
		);

		// The independent setup work is complete before counters are read. A
		// restored per-candidate probe would increase access calls fourfold;
		// removing entrySet.has would also admit the three missing names.
		expect(large).toEqual(small);
		expect(accessMock.mock.calls.length).toBe(smallAccesses);
		expect(readdirMock.mock.calls.length).toBe(smallReads);
	});

	it.skipIf(process.platform === "win32")(
		"rejects dangling symlinks but keeps accessible matched files",
		async () => {
			// Windows ACL denial is not deterministic on the developer and CI
			// accounts, so the inaccessible-entry axis remains a stated non-goal;
			// the production access check still preserves the old failure semantics.
			const ancestor = path.join(tmpDir, "project");
			const sourceDir = path.join(ancestor, "src");
			const nested = path.join(sourceDir, "deep");
			await fsp.mkdir(nested, { recursive: true });
			await fsp.writeFile(path.join(sourceDir, "real.config"), "ok\n");
			await fsp.symlink(
				path.join(sourceDir, "missing-target"),
				path.join(sourceDir, "dangling.config"),
			);

			await expect(
				_findUpForTests(["dangling.config", "real.config"], nested, ancestor),
			).resolves.toEqual([path.join(sourceDir, "real.config")]);
		},
	);

	it("invalidates cold and warm results for config create and remove", async () => {
		const filePath = path.join(tmpDir, "init.lua");
		const configPath = path.join(tmpDir, "stylua.toml");

		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
		await fsp.writeFile(configPath, "column_width = 100\n");
		// No polling: an external mutation remains invisible until its owner
		// reports the path through invalidateFormatterCacheForPath.
		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);

		invalidateFormatterCacheForPath(configPath);
		expect(
			(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
		).toEqual(["stylua"]);

		await fsp.writeFile(configPath, "column_width = 120\n");
		invalidateFormatterCacheForPath(configPath);
		readdirMock.mockClear();
		expect(
			(await getFormattersForFile(filePath, tmpDir)).map((f) => f.name),
		).toEqual(["stylua"]);
		expect(readdirMock.mock.calls.length).toBeGreaterThan(0);

		await fsp.rm(configPath);
		invalidateFormatterCacheForPath(configPath);
		expect(await getFormattersForFile(filePath, tmpDir)).toEqual([]);
	});
});
