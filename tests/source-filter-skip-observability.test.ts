import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../clients/latency-logger.js";

// #1107 observability-first slice: the source walk silently drops real files
// whose NAMES match generated-artifact heuristics (e.g. a real `src/gen.ts`)
// with no visibility anywhere. This test file exercises the new per-walk skip
// counters on `SourceCollectionResult` and the one-line rollup log emitted
// through the existing `logLatency` channel when nonzero.
//
// `logLatency` no-ops in test mode (`isTestMode()`), so the log-line
// assertions mock the module — same pattern as
// `tests/clients/cache-observability.test.ts`.
const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../clients/latency-logger.js", () => ({
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	collectSourceFilesWithBudget,
	collectSourceFilesWithBudgetAsync,
} from "../clients/source-filter.js";
import { removeTempDirSync } from "./clients/test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	latencyEntries.length = 0;
});

function mkTempDir(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "source-filter-skip-obs-"),
	);
	cleanups.push(() => removeTempDirSync(dir));
	return dir;
}

/**
 * A normal file + a real source file whose NAME matches the generated-
 * artifact heuristic (`isGeneratedOrArtifact`'s `/(^|[._-])gen([._-])/`
 * pattern matches "gen.ts") + a compiled-looking sibling that gets skipped by
 * the artifact-probe (sibling-source) path — one skip of each observability
 * class, plus one kept file, in a single walk.
 */
function createMixedSkipTree(): string {
	const dir = mkTempDir();
	// Kept: ordinary hand-written source, no name/sibling match.
	fs.writeFileSync(
		path.join(dir, "alpha.ts"),
		"export function alphaFn() {\n\treturn 1;\n}\n",
	);
	// Skipped via the generated/artifact NAME heuristic (classifyEntry's
	// `shouldSkipGeneratedOrArtifact` -> `generatedOrArtifactSkips`).
	fs.writeFileSync(
		path.join(dir, "gen.ts"),
		"export function genFn() {\n\treturn 1;\n}\n",
	);
	// Skipped via the artifact-probe / sibling-source path (classifyEntry's
	// `isBuildArtifact` -> `buildArtifactSkips`): `compiled.js` has a
	// higher-precedence `.ts` twin sitting right next to it.
	fs.writeFileSync(
		path.join(dir, "compiled.ts"),
		"export function compiledFn() {\n\treturn 1;\n}\n",
	);
	fs.writeFileSync(
		path.join(dir, "compiled.js"),
		"exports.compiledFn = function () { return 1; };\n",
	);
	return dir;
}

describe("source walk skip observability (#1107)", () => {
	it("sync walk: counts generated-name and artifact-probe skips separately and surfaces them on the result", () => {
		const dir = createMixedSkipTree();
		const result = collectSourceFilesWithBudget(dir);

		expect(result.files.sort()).toEqual(
			[path.join(dir, "alpha.ts"), path.join(dir, "compiled.ts")].sort(),
		);
		expect(result.generatedOrArtifactSkips).toBe(1);
		expect(result.buildArtifactSkips).toBe(1);

		const summary = latencyEntries.find(
			(e) => e.phase === "source_walk_skip_summary",
		);
		expect(summary).toBeDefined();
		expect(summary?.metadata).toEqual({
			generatedOrArtifactSkips: 1,
			buildArtifactSkips: 1,
		});
	});

	it("async walk: agrees with the sync walk on skip counts and result fields", async () => {
		const dir = createMixedSkipTree();
		const result = await collectSourceFilesWithBudgetAsync(dir);

		expect(result.files.sort()).toEqual(
			[path.join(dir, "alpha.ts"), path.join(dir, "compiled.ts")].sort(),
		);
		expect(result.generatedOrArtifactSkips).toBe(1);
		expect(result.buildArtifactSkips).toBe(1);

		const summary = latencyEntries.find(
			(e) => e.phase === "source_walk_skip_summary",
		);
		expect(summary).toBeDefined();
	});

	it("emits no log line and reports zero counters when a walk has no name/artifact-probe skips", () => {
		const dir = mkTempDir();
		fs.writeFileSync(
			path.join(dir, "alpha.ts"),
			"export function alphaFn() {\n\treturn 1;\n}\n",
		);
		fs.writeFileSync(
			path.join(dir, "beta.ts"),
			"export function betaFn() {\n\treturn 1;\n}\n",
		);

		const result = collectSourceFilesWithBudget(dir);

		expect(result.files.length).toBe(2);
		expect(result.generatedOrArtifactSkips).toBe(0);
		expect(result.buildArtifactSkips).toBe(0);
		expect(
			latencyEntries.some((e) => e.phase === "source_walk_skip_summary"),
		).toBe(false);
	});

	it("emits no log line on a zero-skip async walk either", async () => {
		const dir = mkTempDir();
		fs.writeFileSync(
			path.join(dir, "alpha.ts"),
			"export function alphaFn() {\n\treturn 1;\n}\n",
		);

		const result = await collectSourceFilesWithBudgetAsync(dir);

		expect(result.generatedOrArtifactSkips).toBe(0);
		expect(result.buildArtifactSkips).toBe(0);
		expect(
			latencyEntries.some((e) => e.phase === "source_walk_skip_summary"),
		).toBe(false);
	});
});
