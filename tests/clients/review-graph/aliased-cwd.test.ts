import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	_resetReviewGraphSourcePathMemoForTests,
} from "../../../clients/review-graph/builder.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
} from "../../../clients/review-graph/service.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

/**
 * Recurrence (#4101): `addJsTsFile` handed `localImportToFile` the caller's
 * spelling of the project root with a CANONICAL file key (`normalizeMapKey`).
 * Whenever the two disagree, `path.relative(root, candidate)` started with
 * `..` and every relative import edge was silently dropped: `directImporters`
 * came back empty and the impact cascade lost its importers.
 *
 * Where the two disagree depends on the host. Windows `normalizeMapKey` is
 * `realpathSync.native`, which expands 8.3 names, junctions and subst drives.
 * The POSIX arm adopts only the on-disk CASING (`adoptCanonicalCasing`) and
 * never resolves a symlink, so on POSIX the divergence exists only on a
 * case-insensitive mount (macOS APFS, `nocase` vfat/ntfs3), which no Linux
 * test box has.
 */
async function directImportersOf(
	cwd: string,
	changed: string[],
	target: string,
): Promise<string[]> {
	const graph = await buildOrUpdateGraph(cwd, changed, new FactStore());
	return computeImpactCascade(graph, target).directImporters;
}

const SRC_A = "export function alpha() { return 1; }\n";
const SRC_B = [
	"import { alpha } from './a';",
	"export function beta() { return alpha(); }",
	"",
].join("\n");

describe("review graph with a project root spelled differently from the canonical keys (#4101)", () => {
	afterEach(() => {
		clearGraphCache();
		clearReviewGraphWorkspaceCache();
		_resetReviewGraphSourcePathMemoForTests();
	});

	// A directory junction is the Windows spelling of an OneDrive/profile
	// redirect; `realpathSync.native` expands it in the file keys while the root
	// stays the junction path. Runs on the "Unit tests Windows (advisory)" job.
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"keeps the import edge when cwd is a junction to the real root",
		async () => {
			const real = setupTestEnvironment("pi-lens-rg-junction-real-");
			const holder = setupTestEnvironment("pi-lens-rg-junction-link-");
			try {
				const linkRoot = path.join(holder.tmpDir, "project-link");
				fs.symlinkSync(real.tmpDir, linkRoot, "junction");
				const aPath = createTempFile(linkRoot, "src/a.ts", SRC_A);
				const bPath = createTempFile(linkRoot, "src/b.ts", SRC_B);
				// The premise: the key expands the junction, the root does not.
				expect(normalizeMapKey(bPath).toLowerCase()).not.toBe(
					bPath.replace(/\\/g, "/").toLowerCase(),
				);
				const importers = await directImportersOf(
					linkRoot,
					[aPath, bPath],
					aPath,
				);
				expect(importers).toContain(normalizeMapKey(bPath));
			} finally {
				holder.cleanup();
				real.cleanup();
			}
		},
	);
});
