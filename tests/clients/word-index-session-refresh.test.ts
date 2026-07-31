import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	refreshWordIndexIncrementally,
	searchWordIndex,
} from "../../clients/word-index.js";
import { _resetProjectScaleBaseForTests } from "../../clients/project-scale.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	delete process.env.PI_LENS_MAX_PROJECT_FILES;
	_resetProjectScaleBaseForTests();
});

describe("session-start incremental word-index refresh (#958)", () => {
	it("reads and refreshes exactly one stale file while reusing the rest", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-stale-");
		try {
			const a = createTempFile(env.tmpDir, "src/a.ts", "export const oldZephyr = 1;");
			createTempFile(env.tmpDir, "src/b.ts", "export const stableBeta = 2;");
			createTempFile(env.tmpDir, "src/c.ts", "export const stableGamma = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			fs.writeFileSync(a, "export const newQuartz = 1;", "utf8");
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(a, future, future);
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			expect(result).toEqual({
				mode: "incremental",
				refreshed: 1,
				dropped: 0,
				reused: 2,
			});
			expect(searchWordIndex(index, "newQuartz")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "oldZephyr")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("drops a deleted file", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-delete-");
		try {
			const deleted = createTempFile(
				env.tmpDir,
				"src/deleted.ts",
				"export const deletedZephyr = 1;",
			);
			createTempFile(env.tmpDir, "src/kept.ts", "export const keptQuartz = 2;");
			createTempFile(env.tmpDir, "src/kept2.ts", "export const keptTwo = 2;");
			createTempFile(env.tmpDir, "src/kept3.ts", "export const keptThree = 3;");
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			fs.unlinkSync(deleted);

			expect(await refreshWordIndexIncrementally(index, env.tmpDir)).toMatchObject({
				refreshed: 0,
				dropped: 1,
				reused: 3,
			});
			expect(searchWordIndex(index, "deletedZephyr")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("re-evaluates the derived cap and flips truncated on growth", async () => {
		const env = setupTestEnvironment("pi-lens-word-refresh-cap-");
		try {
			process.env.PI_LENS_MAX_PROJECT_FILES = "2"; // word-index ratio => cap 6
			_resetProjectScaleBaseForTests();
			for (let i = 0; i < 5; i++) {
				createTempFile(env.tmpDir, `src/f${i}.ts`, `export const value${i} = ${i};`);
			}
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			expect(index.truncated).toBe(false);

			createTempFile(env.tmpDir, "src/f5.ts", "export const value5 = 5;");
			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.refreshed).toBe(1);
			expect(index.docCount).toBe(6);
			expect(index.truncated).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
