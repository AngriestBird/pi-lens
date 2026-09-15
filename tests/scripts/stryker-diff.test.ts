import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	capMutationFiles,
	classifyStrykerFailure,
	formatCapNotice,
	formatStrykerFailure,
	formatVitestCommand,
	isScriptMutationFile,
	mapRelatedTests,
	strykerSpawnOptions,
} from "../../scripts/lib/stryker-diff.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

const execFileSync = vi.fn();
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ execFileSync, spawnSync }));

const config = readFileSync(
	resolve(import.meta.dirname, "../../stryker.config.mjs"),
	"utf8",
);

afterEach(() => {
	execFileSync.mockReset();
	spawnSync.mockReset();
});

describe("stryker diff selection", () => {
	it.each([
		["extensionless", 'import "../../scripts/lib/ci-checks"'],
		["javascript extension", 'import "../../scripts/lib/ci-checks.js"'],
		["module extension", 'import "../../scripts/lib/ci-checks.mjs"'],
		["side-effect", 'import "../../scripts/lib/ci-checks"'],
		["dynamic", 'await import("../../scripts/lib/ci-checks")'],
	])("maps %s relative imports to the changed script", (_form, source) => {
		// Recurrence: extension spelling and import form must not hide a related
		// test from the incremental mutation lane.
		const result = mapRelatedTests(["scripts/lib/ci-checks.mjs"], {
			testFiles: ["tests/scripts/related.test.ts"],
			readFile: () => source,
		});

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/related.test.ts"]),
		);
	});

	it("maps changed scripts to imported and conventional sibling tests", () => {
		// Recurrence: the mutation lane must run tests that import the changed
		// script, including scripts without a same-path test mirror.
		const result = mapRelatedTests(
			["scripts/lib/ci-checks.mjs", "scripts/guard-bash.mjs"],
			{
				testFiles: [
					"tests/scripts/ci-verdict.test.ts",
					"tests/scripts/guard-bash.test.ts",
				],
				readFile: (file) =>
					file.includes("ci-verdict")
						? 'import checks from "../../scripts/lib/ci-checks.mjs"'
						: "",
			},
		);

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/ci-verdict.test.ts"]),
		);
		expect(result.related.get("scripts/guard-bash.mjs")).toEqual(
			new Set(["tests/scripts/guard-bash.test.ts"]),
		);
		expect(result.tests).toEqual([
			"tests/scripts/ci-verdict.test.ts",
			"tests/scripts/guard-bash.test.ts",
		]);
	});

	it("reports changed scripts with no covering test instead of silently selecting none", () => {
		// Recurrence: a changed mutation target without a related test must be a
		// review finding, not an accidental green mutation run.
		const result = mapRelatedTests(["scripts/uncovered.mjs"], {
			testFiles: ["tests/scripts/other.test.ts"],
			readFile: () => "",
		});

		expect(result.uncovered).toEqual(["scripts/uncovered.mjs"]);
		expect(result.covered).toEqual([]);
		expect(result.tests).toEqual([]);
	});

	it("caps the mutation population alphabetically and names skipped files", () => {
		// Recurrence: an unbounded changed-script population can turn the
		// advisory lane into an unbounded CI cost.
		const result = capMutationFiles(
			["scripts/z.mjs", "scripts/a.mjs", "scripts/m.mjs"],
			2,
		);

		expect(result.selected).toEqual(["scripts/a.mjs", "scripts/m.mjs"]);
		expect(result.skipped).toEqual(["scripts/z.mjs"]);
		expect(formatCapNotice(2, 3, result.skipped)).toBe(
			"capped: 2 of 3 changed scripts mutated; skipped: scripts/z.mjs",
		);
	});

	it("gives mutation-only Vitest runs their own timeout", () => {
		// Recurrence: instrumented dry runs exceeded Vitest's ordinary 5s budget,
		// so Stryker evaluated zero mutants and reported only an advisory red.
		expect(
			formatVitestCommand(["tests/scripts/check-pr-body.test.ts"]),
		).toBe(
			"node_modules/.bin/vitest run --configLoader runner --testTimeout 30000 'tests/scripts/check-pr-body.test.ts'",
		);
	});

	it("distinguishes a dry-run failure before mutant evaluation", () => {
		// Recurrence: a failed initial test run was reported as an ordinary Stryker
		// status, hiding that the mutation lane tested nothing.
		const dryRunOutput = [
			"INFO Instrumenter Instrumented 1 source file(s) with 1803 mutant(s)",
			"ERROR DryRunExecutor One or more tests failed in the initial test run:",
		].join("\n");
		expect(classifyStrykerFailure(dryRunOutput)).toBe(
			"dry-run-no-mutants-evaluated",
		);
		expect(
			classifyStrykerFailure(
				"ERROR TestRunner One or more tests failed while running a mutant",
			),
		).toBe("stryker-failure");
	});

	it("does not classify unrelated output as a dry-run failure", () => {
		// The bounded capture may contain ordinary test failures or output from a
		// later Stryker phase; those retain the generic advisory status.
		expect(
			classifyStrykerFailure(
				"ERROR DryRunExecutor command failed before the initial test run",
			),
		).toBe("stryker-failure");
	});

	it("formats distinct Stryker outcomes from bounded child output", () => {
		const dryRun =
			"ERROR DryRunExecutor One or more tests failed in the initial test run:";
		expect(formatStrykerFailure({ status: 1, stdout: dryRun })).toBe(
			"mutation diff: dry run failed; no mutants evaluated (Stryker status 1)",
		);
		expect(formatStrykerFailure({ status: 1, stderr: "ordinary failure" })).toBe(
			"mutation diff: Stryker status 1",
		);
	});

	it("bounds captured Stryker output while preserving both streams", () => {
		expect(strykerSpawnOptions()).toEqual({
			stdio: ["inherit", "pipe", "pipe"],
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
	});

	it("runs the real entrypoint with timeout and dry-run failure wiring", async () => {
		// Recurrence: helper-only assertions can pass while the entrypoint still
		// writes the old command or emits only a generic Stryker status.
		const { tmpDir: fixtureCwd, cleanup } = setupTestEnvironment(
			"pi-lens-stryker-entrypoint-",
		);
		const previousCwd = process.cwd();
		const previousArgv = process.argv;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`process.exit(${code})`);
		}) as never);
		let errorOutput = "";
		try {
			mkdirSync(join(fixtureCwd, "tests", "scripts"), { recursive: true });
			writeFileSync(
				join(fixtureCwd, "tests", "scripts", "stryker-diff.test.ts"),
				"it(\"entrypoint fixture\", () => {});\n",
			);
			process.chdir(fixtureCwd);
			process.argv = [
				process.execPath,
				"scripts/stryker-diff.mjs",
				"--base",
				"origin/master",
				"--max-files",
				"6",
			];
			execFileSync.mockReturnValue("scripts/stryker-diff.mjs\n");
			spawnSync.mockReturnValue({
				status: 1,
				stdout:
					"ERROR DryRunExecutor One or more tests failed in the initial test run:\n",
				stderr: "",
			});

			const entrypoint = new URL(
				"../../scripts/stryker-diff.mjs",
				import.meta.url,
			);
			await expect(
				import(`${entrypoint.href}?production-seam`),
			).rejects.toThrow("process.exit(1)");
			errorOutput = error.mock.calls
				.map(([message]) => String(message))
				.join("\n");
			const generatedConfig = readFileSync(
				join(fixtureCwd, ".stryker", "diff.config.mjs"),
				"utf8",
			);
			expect(generatedConfig).toContain("--testTimeout 30000");
			expect(execFileSync).toHaveBeenCalledWith(
				"git",
				["diff", "--name-only", "--diff-filter=AM", "origin/master...HEAD"],
				{ encoding: "utf8" },
			);
			expect(spawnSync).toHaveBeenCalledWith(
				"node_modules/.bin/stryker",
				[
					"run",
					"--mutate",
					"scripts/stryker-diff.mjs",
					".stryker/diff.config.mjs",
				],
				expect.objectContaining({
					stdio: ["inherit", "pipe", "pipe"],
					encoding: "utf8",
					maxBuffer: 10 * 1024 * 1024,
				}),
			);
		} finally {
			exit.mockRestore();
			error.mockRestore();
			process.argv = previousArgv;
			process.chdir(previousCwd);
			cleanup();
		}
		expect(errorOutput).toContain(
			"mutation diff: dry run failed; no mutants evaluated (Stryker status 1)",
		);
	});

	it("keeps the mutation population on scripts mjs files", () => {
		// Recurrence: mutating compiled clients or test sources produces vacuous
		// mutants because this lane activates the built runtime in memory.
		expect(isScriptMutationFile("scripts/hooks/guard-bash.mjs")).toBe(true);
		expect(isScriptMutationFile("scripts/example.test.mjs")).toBe(false);
		expect(isScriptMutationFile("clients/runtime.ts")).toBe(false);
		expect(config).toContain('testRunner: "command"');
		expect(config).toContain(
			'command: "node_modules/.bin/vitest run --configLoader runner"',
		);
		expect(config).toContain('"scripts/**/*.mjs", "!scripts/**/*.test.mjs"');
		expect(config).toContain('coverageAnalysis: "off"');
		expect(config).not.toContain("vitest:");
		// Spike 2026-09-09: TypeScript 7 lacks the API Stryker's sandbox tsconfig
		// preprocessor calls, so the lane mutates in place; the in-place reset
		// drops compiled clients/*.js, so one build runs before the dry run.
		// Neither implies a per-mutant rebuild: the population is .mjs run directly.
		expect(config).toContain('buildCommand: "npm run build"');
		expect(config).toContain("inPlace: true");
		expect(config).not.toContain("clients/");
	});
});
