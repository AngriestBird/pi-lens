/**
 * #1107 phase 2 item 2 — tool-facing surfacing of the generated-name walk
 * skip counters.
 *
 * Phase 1 (#1111) added `generatedOrArtifactSkips`/`buildArtifactSkips` on
 * `SourceCollectionResult` plus a `latency.log` rollup, but nothing outside
 * that log line told a user/agent "N files were excluded by the
 * generated-name heuristic" — the exact tool-facing observability the issue
 * asked for. This mirrors `diagnostics-truncation.test.ts`'s #784 pattern
 * (scanTruncated -> scanTruncationNotice) for the two new counters:
 *   1. `scanProjectDiagnostics` (`project-diagnostics/scanner.ts`) threads
 *      `SourceCollectionResult.generatedOrArtifactSkips`/`generatedDirSkips`
 *      into `ProjectDiagnosticsSnapshot.generatedFileSkips`/
 *      `generatedDirSkips`.
 *   2. `lens-engine.ts`'s `generatedSkipNotice` renders them into a one-line
 *      notice (mirroring `scanTruncationNotice`'s style/absence contract).
 */

import { describe, expect, it } from "vitest";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import { generatedSkipNotice } from "../../clients/lens-engine.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

describe("project-diagnostics generated-name skip surfacing (#1107 phase 2)", () => {
	it("generatedFileSkips/generatedDirSkips are absent on a scan with nothing excluded", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: { "src/index.ts": "export const v = 1;\n" },
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedFileSkips).toBeUndefined();
			expect(snapshot.generatedDirSkips).toBeUndefined();
			expect(generatedSkipNotice(snapshot)).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});

	it("generatedFileSkips counts a name-only match confirmed by a generated header, and the notice mentions it", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				// Confirmed generated (header evidence) -> a real
				// generatedOrArtifactSkips, not an escape-hatch override.
				"src/gen.ts":
					"// This file was automatically generated.\nexport const g = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedFileSkips).toBe(1);
			const notice = generatedSkipNotice(snapshot);
			expect(notice).toBeDefined();
			expect(notice).toContain("1 file(s)");
			expect(notice).toContain("generated-name heuristics");
		} finally {
			repo.cleanup();
		}
	});

	it("generatedDirSkips counts a whole pruned directory, and the notice pluralizes correctly", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"generated/one.ts": "export const one = 1;\n",
				"generated/two.ts": "export const two = 2;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
			});
			expect(snapshot.generatedDirSkips).toBe(1);
			const notice = generatedSkipNotice(snapshot);
			expect(notice).toBeDefined();
			expect(notice).toContain("1 directory");
		} finally {
			repo.cleanup();
		}
	});

	it("an explicit `files` scan never populates the counters (never walked)", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: {
				"src/index.ts": "export const v = 1;\n",
				"src/gen.ts":
					"// This file was automatically generated.\nexport const g = 1;\n",
			},
		};
		const repo = makeMonorepo({ packages: [pkg] });
		try {
			const path = await import("node:path");
			const snapshot = await scanProjectDiagnostics({
				cwd: repo.root,
				tier: "cheap",
				files: [path.join(repo.root, "packages", "a", "src", "index.ts")],
			});
			expect(snapshot.generatedFileSkips).toBeUndefined();
			expect(snapshot.generatedDirSkips).toBeUndefined();
			expect("generatedFileSkips" in snapshot).toBe(false);
		} finally {
			repo.cleanup();
		}
	});
});
