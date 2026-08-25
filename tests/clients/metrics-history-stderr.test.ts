/**
 * #2095 — `getCurrentCommit()` in `clients/metrics-history.ts` ran
 * `execSync("git rev-parse --short HEAD")` without an explicit `stdio`
 * override. Node's `execSync`/`execFileSync` inherit the child's stderr to
 * the PARENT process by default (only stdout is piped into the return
 * value), so a failing `git rev-parse` prints its raw "fatal: ..." line
 * straight into the pi TUI, bypassing the surrounding try/catch entirely —
 * the catch only sees the thrown (non-zero exit) error, never the
 * already-inherited stderr stream.
 *
 * This spawns a REAL child Node process (not a mock) that requires the
 * compiled runtime module and calls `captureSnapshot()` with its cwd set to
 * a real git repo that has zero commits, so `git rev-parse --short HEAD`
 * genuinely fails and genuinely writes to stderr. The child's own stderr is
 * inherited straight from the grandchild `git` process pre-fix, so this
 * test observes the real leak rather than asserting on mocked call
 * arguments.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const METRICS_HISTORY_JS = path.resolve(
	__dirname,
	"../../clients/metrics-history.js",
);

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("metrics-history getCurrentCommit stderr suppression (#2095)", () => {
	it.skipIf(!hasGit())(
		"does not leak git's stderr when rev-parse fails in a commit-less repo",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-metrics-history-"),
			);
			try {
				// A real repo with zero commits: `git rev-parse --short HEAD`
				// genuinely fails with "fatal: ambiguous argument 'HEAD': unknown
				// revision or path not in the working tree." on real stderr.
				execFileSync("git", ["init", "-q"], { cwd: tmp });

				const dataDir = path.join(tmp, ".pilens-data");
				const filePath = path.join(tmp, "file.ts");
				const script = [
					`process.chdir(${JSON.stringify(tmp)});`,
					`const { captureSnapshot } = require(${JSON.stringify(METRICS_HISTORY_JS)});`,
					"captureSnapshot(",
					`  ${JSON.stringify(filePath)},`,
					"  {",
					"    maintainabilityIndex: 90,",
					"    cognitiveComplexity: 1,",
					"    maxNestingDepth: 1,",
					"    linesOfCode: 10,",
					"    maxCyclomatic: 1,",
					"    entropy: 1,",
					"  },",
					");",
				].join("\n");

				const result = spawnSync(process.execPath, ["-e", script], {
					cwd: tmp,
					encoding: "utf-8",
					env: { ...process.env, PILENS_DATA_DIR: dataDir },
				});

				expect(result.error).toBeUndefined();
				// The bug: git's raw "fatal: ..." line lands on the child's own
				// stderr, unfiltered by any try/catch inside getCurrentCommit().
				expect(result.stderr).not.toMatch(/fatal:/i);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);
});
