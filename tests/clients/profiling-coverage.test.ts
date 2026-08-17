/**
 * Profiling coverage: what percent of the walk/profile hot path a
 * representative source-tree workload actually executes.
 *
 * Occupancy tests (`source-walk-occupancy.test.ts`) guard event-loop stalls.
 * This is the complementary reach metric — pyinstrument-style "did the
 * profiler even touch the production modules" — using V8 precise coverage
 * on the in-place compiled clients.
 *
 * #1521: the original guard checked an AGGREGATE ratio across all 8 hot-path
 * files. A module-scoped regression — e.g. `source-filter.ts` silently
 * bypassing its delegation to `source-walker.ts`'s `walkTreeRecursiveSync`/
 * `walkTreeStackAsync` and reimplementing the walk inline — barely moves the
 * 8-file aggregate (source-walker.js is one of eight files, and other
 * callers of the shared walker still exercise most of it), so the ratio
 * floor never tripped. This guard now uses PER-MODULE absolute
 * function-count floors (deterministic reach on the fixed TREE_SIZE
 * fixture — no timing, so no ambient-noise headroom needed) plus explicit
 * named-must-execute checks for the two delegation entry points #1521 named,
 * so a bypass of either one fails this test directly instead of hiding
 * inside an aggregate that "cannot fail."
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { detectProjectLanguageProfileAsync } from "../../clients/language-profile.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import { countSourceFilesWithinLimitAsync } from "../../clients/startup-scan.js";
import { generateSourceTree } from "../support/perf-harness.js";
import {
	fileFromScriptUrl,
	summarizePreciseCoverage,
	withPreciseCoverage,
} from "../support/v8-coverage.js";
import { removeTempDirSync } from "./test-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TREE_SIZE = 400;

/** Compiled in-place clients the walk/profile workload must reach. */
const HOT_PATH = [
	"clients/file-kinds.js",
	"clients/file-utils.js",
	"clients/generated-artifacts.js",
	"clients/language-profile.js",
	"clients/path-utils.js",
	"clients/source-filter.js",
	"clients/source-walker.js",
	"clients/startup-scan.js",
] as const;

const MIN_FILES_TOUCHED = HOT_PATH.length;

/**
 * Absolute per-module function-count floors (#1521), measured against a
 * local run of this fixture (functionsHit / functionCount):
 *   file-kinds.js 2/2, file-utils.js 31/32, generated-artifacts.js 17/17,
 *   language-profile.js 9/9, path-utils.js 16/16, source-filter.js 30/34,
 *   source-walker.js 11/11, startup-scan.js 6/6.
 * Each floor keeps a small margin (1-3 functions) for the one path known to
 * vary with filesystem/cache state (the generated-header content probe in
 * `source-filter.ts`), NOT for ambient timing noise — this metric is
 * deterministic reach on a fixed synthetic tree, so the margin stays tight
 * enough that dropping even one meaningfully-sized module's function trips
 * its own floor instead of hiding in an aggregate.
 */
const MIN_FUNCTIONS_HIT: Record<(typeof HOT_PATH)[number], number> = {
	"clients/file-kinds.js": 2,
	"clients/file-utils.js": 29,
	"clients/generated-artifacts.js": 16,
	"clients/language-profile.js": 8,
	"clients/path-utils.js": 15,
	"clients/source-filter.js": 27,
	"clients/source-walker.js": 10,
	"clients/startup-scan.js": 5,
};

/**
 * Named must-execute functions (#1521) — the two shared-walker delegation
 * entry points the guard exists to protect. `source-filter.ts`'s sync
 * collector calls ONLY `walkTreeRecursiveSync` for its traversal and no
 * other hot-path caller reaches it, so bypassing that delegation (e.g.
 * reimplementing the walk inline instead of calling through
 * `source-walker.ts`) zeroes this function specifically while barely
 * denting the file's aggregate percentage or the 8-file rollup.
 */
const MUST_EXECUTE_FUNCTIONS: Record<string, readonly string[]> = {
	"clients/source-walker.js": ["walkTreeRecursiveSync", "walkTreeStackAsync"],
};

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-profiling-coverage-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	_resetGeneratedArtifactCaches();
});

describe(`profiling coverage of walk/profile hot path (~${TREE_SIZE} files)`, () => {
	it(
		"executes a minimum share of functions and blocks in the hot-path clients",
		{ timeout: 30_000 },
		async () => {
			const { result, scripts } = await withPreciseCoverage(async () => {
				const syncFiles = collectSourceFiles(tmpDir);
				const asyncFiles = await collectSourceFilesAsync(tmpDir);
				const profile = await detectProjectLanguageProfileAsync(tmpDir);
				const counted = await countSourceFilesWithinLimitAsync(tmpDir, 1_000_000);
				return { syncFiles, asyncFiles, profile, counted };
			});

			expect(result.syncFiles.length).toBeGreaterThan(0);
			expect(result.asyncFiles).toEqual(result.syncFiles);
			expect(result.counted).toBeGreaterThan(0);
			expect(result.profile).toBeTruthy();

			const summary = summarizePreciseCoverage(scripts, {
				root: repoRoot,
				include: HOT_PATH,
			});
			const missing = HOT_PATH.filter(
				(file) => !summary.files.some((entry) => entry.file === file && entry.functionsHit > 0),
			);

			expect(
				missing,
				`hot-path modules with zero executed functions: ${missing.join(", ") || "(none)"}`,
			).toEqual([]);
			expect(summary.filesTouched).toBeGreaterThanOrEqual(MIN_FILES_TOUCHED);

			// Per-module absolute function-count floors (#1521) — replaces the
			// 8-file aggregate ratio a module-scoped regression could hide inside.
			const shortfalls = HOT_PATH.filter((file) => {
				const entry = summary.files.find((f) => f.file === file);
				return (entry?.functionsHit ?? 0) < MIN_FUNCTIONS_HIT[file];
			}).map((file) => {
				const entry = summary.files.find((f) => f.file === file);
				return `${file}: ${entry?.functionsHit ?? 0}/${MIN_FUNCTIONS_HIT[file]} functions`;
			});
			expect(shortfalls, `modules under their function-count floor: ${shortfalls.join(", ") || "(none)"}`).toEqual(
				[],
			);

			// Named must-execute functions (#1521) — the shared-walker delegation
			// entry points a bypass would silently skip without moving the
			// per-file function count enough to trip the floor above.
			const executedByFile = new Map<string, Set<string>>();
			for (const script of scripts) {
				const file = fileFromScriptUrl(script.url, repoRoot);
				if (!file) continue;
				const hit = executedByFile.get(file) ?? new Set<string>();
				for (const fn of script.functions) {
					if (fn.ranges.some((range) => range.count > 0)) hit.add(fn.functionName);
				}
				executedByFile.set(file, hit);
			}
			const missingNamed: string[] = [];
			for (const [file, names] of Object.entries(MUST_EXECUTE_FUNCTIONS)) {
				const hit = executedByFile.get(file) ?? new Set<string>();
				for (const name of names) {
					if (!hit.has(name)) missingNamed.push(`${file}#${name}`);
				}
			}
			expect(
				missingNamed,
				`must-execute functions never called: ${missingNamed.join(", ") || "(none)"}`,
			).toEqual([]);
		},
	);
});
