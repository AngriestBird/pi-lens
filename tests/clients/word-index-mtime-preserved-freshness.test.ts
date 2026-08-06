import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	collectWordIndexDocs,
	deserializeWordIndex,
	refreshWordIndexIncrementally,
	searchWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { _resetProjectScaleBaseForTests } from "../../clients/project-scale.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	_resetProjectScaleBaseForTests();
});

// #1105: the incremental refresh gate was mtime-ONLY, so a content change that
// PRESERVES mtime (git checkout timestamp restoration, a formatter preserving
// mtime, a same-clock write) left the old postings serving STALE identifiers to
// symbol_search. The fix adds the review-graph gold-standard second axis — byte
// size, free from the stat the walk already runs — so any content change that
// alters length is caught even when mtime is identical.
//
// To make the mtime axis match EXACTLY (so it is size ALONE that must trigger
// the re-read — the test cannot pass vacuously via an accidental mtime delta),
// the file's mtime is pinned to the SAME fixed Date before indexing and again
// after the edit: setting an identical Date twice yields an identical on-disk
// `mtimeMs`, which `fs.utimesSync`'s round-trip of a natural mtime does not.
const PINNED_MTIME = new Date(Date.now() - 60_000);

describe("word-index freshness: mtime preserved, content changed (#1105)", () => {
	it("re-reads a file whose content+size changed but mtime did not", async () => {
		const env = setupTestEnvironment("pi-lens-word-mtime-preserved-");
		try {
			const a = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const zephyrAlpha = 1;",
			);
			createTempFile(env.tmpDir, "src/b.ts", "export const stableBeta = 2;");
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const recorded = fs.statSync(a);
			const index = buildWordIndex(await collectWordIndexDocs(env.tmpDir));

			// Sanity: the pre-edit identifier is indexed, the post-edit one is not.
			expect(searchWordIndex(index, "zephyrAlpha")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "quokka")).toEqual([]);

			// Different identifier AND a different byte length (longer), then re-pin
			// the SAME mtime so the mtime axis is byte-for-byte unchanged.
			fs.writeFileSync(a, "export const quokkaOmegaDistinct = 1;", "utf8");
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);

			const after = fs.statSync(a);
			// Precondition: mtime preserved exactly; only size moved. If this ever
			// fails the test fails loudly rather than proving the wrong thing.
			expect(after.mtimeMs).toBe(recorded.mtimeMs);
			expect(after.size).not.toBe(recorded.size);

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);

			// Post-fix: the size delta forces the re-read of exactly this one file.
			// Pre-fix (mtime-only gate) this file was skipped: `refreshed` was 0 and
			// "quokka" never became searchable while "zephyrAlpha" lingered.
			expect(result.refreshed).toBe(1);
			expect(result.dropped).toBe(0);
			expect(searchWordIndex(index, "quokka")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "zephyrAlpha")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("survives a deserialize→refresh round-trip carrying the size axis", async () => {
		const env = setupTestEnvironment("pi-lens-word-mtime-preserved-rt-");
		try {
			const a = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const roundTripAlpha = 1;",
			);
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const recorded = fs.statSync(a);
			const built = buildWordIndex(await collectWordIndexDocs(env.tmpDir));
			// Round-trip through the persisted (snapshot) shape, as a real session
			// does — proves the size axis survives serialize/deserialize.
			const index = deserializeWordIndex(serializeWordIndex(built));
			if (!index) throw new Error("deserialize returned null");

			fs.writeFileSync(
				a,
				"export const quokkaOmegaDistinct = 1;",
				"utf8",
			);
			fs.utimesSync(a, PINNED_MTIME, PINNED_MTIME);
			const after = fs.statSync(a);
			expect(after.mtimeMs).toBe(recorded.mtimeMs);
			expect(after.size).not.toBe(recorded.size);

			const result = await refreshWordIndexIncrementally(index, env.tmpDir);
			expect(result.refreshed).toBe(1);
			expect(searchWordIndex(index, "quokka")[0]?.file).toBe(a);
			expect(searchWordIndex(index, "roundTripAlpha")).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
