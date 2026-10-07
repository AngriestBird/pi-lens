// flake-shape: real-process-spawn — the real hook stdin/exit-code contract
// and ref-to-ref differential are the subjects; in-process classification
// cannot prove either child-process boundary (#4071).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const probe = join(root, "scripts", "guard-bash-probe.mjs");
const matrix = join(
	root,
	"tests",
	"fixtures",
	"guard-bash-probes",
	"reviewer-corpus.jsonl",
);

describe("guard-bash differential corpus (#4071)", () => {
	it("runs the reviewer corpus through the real hook entry", () => {
		// Recurrence: #4054 R3-1 made substitution-bearing --prefix commands
		// silently allow; the corpus keeps that policy row and the #4025/#4060/
		// #4069 residuals visible while current master remains fail-open there.
		const run = spawnSync(process.execPath, [probe, matrix, "--lane", "both"], {
			cwd: root,
			encoding: "utf8",
		});
		const output = run.stdout;
		const rows = readFileSync(matrix, "utf8").trim().split(/\r?\n/);
		expect(rows).toHaveLength(344);
		expect(output).toContain("counts\trows=");
		// The known-wrong policy rows are intentionally reported by the CLI;
		// every non-residual expected DENY must still hold on this master hook.
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("expected DENY");
	});

	it("shows only changed rows against the #4054 R3 hook", () => {
		const run = spawnSync(
			process.execPath,
			[
				probe,
				matrix,
				"--base",
				"784a6c2d866e20fca037cc7e5cfefe442d1c2c0d",
				"--lane",
				"linked",
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(run.stdout).toContain("counts");
		expect(run.stdout).toContain("npm ci");
		expect(run.stdout).toContain("changed=3");
		expect(run.stdout.trim().split("\n")).toHaveLength(4);
		expect(run.status).toBe(1);
	});
});
