// flake-shape: real-process-spawn — the nightly CLI is the subject: it must run as a real
// child process with PATH pointing at a gh stand-in, which no in-process mock reproduces (#4691).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// #4691: the nightly CLI, run as a child process. The only stand-in is the `gh`
// binary (a process boundary): PATH points at a wrapper that serves the recorded
// master runs. Recurrence guarded: a `%` in a workflow annotation is read as an
// escape, so an unescaped percentage in a warning line corrupts it.
const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = resolve(ROOT, "scripts/check-ci-job-p90.mjs");
const FAKE_GH = resolve(ROOT, "tests/fixtures/ci-job-p90/fake-gh.mjs");
const RECORDED = resolve(ROOT, "tests/fixtures/ci-job-p90/master-runs.json");

describe.skipIf(process.platform === "win32")(
	"nightly CLI scripts/check-ci-job-p90.mjs (#4691)",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-p90-gh-"));
		const wrapper = join(dir, "gh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		afterAll(() => rmSync(dir, { recursive: true, force: true }));

		function run(args: string[], fixturePath: string) {
			return spawnSync(process.execPath, [CLI, ...args], {
				cwd: ROOT,
				encoding: "utf8",
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					FAKE_GH_FIXTURE: fixturePath,
				},
			});
		}

		it("prints one ::warning per over-cap job, with the percent escaped, and exits 0", () => {
			const result = run(["--runs", "20"], RECORDED);
			expect(result.status).toBe(0);
			const warnings = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("::warning"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(
				'::warning title=CI job p90 near timeout::ci.yml job lint-and-typecheck "Lint & type-check"',
			);
			expect(warnings[0]).toContain("75.0%25 of its 600 s cap");
			expect(result.stdout).toContain("1 warning(s)");
		});

		it("refuses --runs outside 1..100 with exit 1", () => {
			const result = run(["--runs", "0"], RECORDED);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--runs must be an integer 1..100");
		});

		it("exits 1 and names the failed read when gh cannot read the runs", () => {
			const failing = join(dir, "failing.json");
			writeFileSync(failing, JSON.stringify({ failRead: true, runs: [] }));
			const result = run(["--runs", "20"], failing);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("gh api");
			expect(result.stderr).toContain("failed (exit 1)");
		});
	},
);
