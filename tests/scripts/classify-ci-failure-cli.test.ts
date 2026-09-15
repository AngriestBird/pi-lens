// flake-shape: real-process-spawn — the subject IS the CLI's own argv
// parsing, exit codes, and `node --import` fetch-stub wiring; an in-process
// call to parseArgs()/runClassifier() (what tests/scripts/ci-failure
// -classifier.test.ts already does) cannot exercise the real child-process
// argv or exit-code behavior the workflow YAML actually depends on.
//
// End-to-end test for the classify-ci-failure.mjs CLI itself (#2668 review
// F2): "the shipped seam scripts/classify-ci-failure.mjs has zero tests;
// renaming the flag to --allow-missing-prs leaves 50/50 green while the
// workflow's real argv throws the exact pre-fix error and exits 1."
//
// tests/scripts/ci-failure-classifier.test.ts exercises `runClassifier` by
// calling the exported library function directly with a JS
// `allowMissingPr: true` property -- it can never notice a mismatch between
// the CLI's `--allow-missing-pr` flag STRING and what the workflow YAML
// actually types on the command line. This file spawns the real CLI as a
// genuine child process with the workflow's exact argv and a stubbed
// `fetch` (via `node --import`, see fixtures/classify-ci-failure-fetch
// -stub.mjs), so a drift in the flag string, in argv wiring, or in exit
// -code semantics shows up here even when the library-level suite stays
// green.
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliPath = join(repoRoot, "scripts", "classify-ci-failure.mjs");
const stubPath = join(here, "fixtures", "classify-ci-failure-fetch-stub.mjs");

// The exact argv .github/workflows/ci-infra-kill-rerun.yml builds when a
// push or repository_dispatch run resolves no PR number (#2668).
const PRODUCTION_PUSH_ARGV = [
	"--run",
	"999",
	"--sha",
	"deadbeef",
	"--infra-kill-only",
	"--skip-missing-job",
	"--allow-missing-pr",
];

describe("classify-ci-failure.mjs CLI (#2668 review F2 -- real child process, real argv)", () => {
	let tmpDir: string;
	let callLogPath: string;
	let piLensHome: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "classify-cli-test-"));
		callLogPath = join(tmpDir, "calls.ndjson");
		writeFileSync(callLogPath, "");
		// Probe hygiene (AGENTS.md): this script touches no pi-lens runtime
		// state today, but an ad-hoc child-process invocation outside vitest's
		// own test-mode gate is exactly the shape that has previously written
		// into the real ~/.pi-lens by accident, so pin homes defensively.
		piLensHome = join(tmpDir, "pi-lens-home");
		mkdirSync(piLensHome, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function runCli(
		argv: string[],
		{
			rerunStatus = "201",
			runAttempt = "1",
		}: { rerunStatus?: string; runAttempt?: string } = {},
	) {
		try {
			const stdout = execFileSync(
				process.execPath,
				["--import", pathToFileURL(stubPath).href, cliPath, ...argv],
				{
					cwd: repoRoot,
					env: {
						...process.env,
						GITHUB_REPOSITORY: "acme/repo",
						GITHUB_TOKEN: "fake-token-for-test",
						CLASSIFY_CLI_TEST_CALL_LOG: callLogPath,
						CLASSIFY_CLI_TEST_RERUN_STATUS: rerunStatus,
						CLASSIFY_CLI_TEST_RUN_ATTEMPT: runAttempt,
						PI_LENS_HOME: piLensHome,
						PILENS_DATA_DIR: piLensHome,
					},
					encoding: "utf8",
				},
			);
			return { status: 0, stdout, stderr: "" };
		} catch (error) {
			const e = error as {
				status: number | null;
				stdout: string;
				stderr: string;
			};
			return { status: e.status ?? -1, stdout: e.stdout, stderr: e.stderr };
		}
	}

	function readCalls() {
		const raw = readFileSync(callLogPath, "utf8").trim();
		if (!raw) return [] as Array<{ method: string; url: string }>;
		return raw
			.split("\n")
			.map((line) => JSON.parse(line) as { method: string; url: string });
	}

	it("runs the workflow's exact push/dispatch argv end to end: classifies, reruns, exits 0, and never touches the comments API", () => {
		const result = runCli(PRODUCTION_PUSH_ARGV);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("no PR (push/dispatch)");
		expect(result.stdout).toContain("infra-kill");
		expect(result.stdout).toContain("rerun triggered");

		const calls = readCalls();
		const rerun = calls.find((c) => c.url.includes("rerun-failed-jobs"));
		expect(rerun).toBeDefined();
		expect(rerun?.method).toBe("POST");

		// The whole point of --allow-missing-pr: a push/dispatch run has no
		// PR thread, so the real CLI process must never hit the comments API.
		const commentCalls = calls.filter((c) => c.url.includes("/comments"));
		expect(commentCalls).toEqual([]);
	});

	// #2042 through the SHIPPED CLI as a child process. The library-level
	// suite drives `runClassifier` with a JS object; only this lane proves
	// the real process reads `run_attempt` off the run it was pointed at.
	// Master lane (`--allow-missing-pr`): no PR, so no marker exists and the
	// attempt is the only thing standing between the kill and a rerun.
	it("#2042: a second infra kill on one head (run_attempt 2) still reruns end to end", () => {
		const result = runCli(PRODUCTION_PUSH_ARGV, { runAttempt: "2" });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("infra-kill");
		expect(result.stdout).toContain("rerun triggered");

		const rerun = readCalls().find((c) => c.url.includes("rerun-failed-jobs"));
		expect(rerun?.method).toBe("POST");
	});

	// The bound, through the same shipped process: attempt 3 is terminal, so
	// the CLI must classify and report WITHOUT posting a rerun. A human can
	// run this CLI on any run id with no workflow gate in front of it, which
	// is why the cap lives in the library and not only in the YAML.
	it("#2042: attempt 3 is terminal — the CLI classifies but posts no rerun", () => {
		const result = runCli(PRODUCTION_PUSH_ARGV, { runAttempt: "3" });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("infra-kill");
		expect(result.stdout).not.toContain("rerun triggered");

		const calls = readCalls();
		expect(calls.filter((c) => c.url.includes("rerun-failed-jobs"))).toEqual(
			[],
		);
		// Still a full classification pass: the log WAS read and judged.
		expect(calls.some((c) => c.url.includes("/actions/jobs/111/logs"))).toBe(
			true,
		);
	});

	it("rejects an unknown flag with exit code 4 instead of silently ignoring it", () => {
		const result = runCli([
			...PRODUCTION_PUSH_ARGV,
			"--this-flag-does-not-exist",
		]);

		expect(result.status).toBe(4);
		expect(result.stderr).toContain(
			"unknown argument: --this-flag-does-not-exist",
		);
		// Must fail before ever reaching the network -- no calls at all.
		expect(readCalls()).toEqual([]);
	});
});
