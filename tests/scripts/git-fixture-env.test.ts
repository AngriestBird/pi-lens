import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	envFor,
	gitExecFileSync,
	gitExecSync,
} from "../../scripts/lib/git-fixture-env.mjs";
import { gitFixtureEnv } from "../support/git-fixture-env.js";

describe("JavaScript Git fixture environment", () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	it("scrubs inherited Git state and config injection", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mjs-git-env-"));
		scratch.push(repo);
		gitExecFileSync(["init", "-q"], { cwd: repo, stdio: "ignore" });
		expect(
			String(
				gitExecFileSync(["rev-parse", "--git-dir"], {
					cwd: repo,
					env: {
						GIT_DIR: path.join(os.tmpdir(), "escape"),
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "core.bare",
						GIT_CONFIG_VALUE_0: "true",
					},
					encoding: "utf8",
				}),
			),
		).toBe(".git\n");
	});

	it("scrubs indexed config keys even without a count (review F1)", () => {
		// GIT_CONFIG_COUNT is scrubbed by name, so git would ignore orphaned
		// KEY/VALUE entries anyway; this pins the pattern loop itself so a
		// future COUNT passthrough cannot resurrect the injection.
		const env = envFor("C:/tmp", {
			GIT_CONFIG_KEY_0: "core.bare",
			GIT_CONFIG_VALUE_0: "true",
		});
		expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
		expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
	});

	// Recurrence: #4552. `git commit` runs `run_auto_maintenance`, which forks a
	// DETACHED `git maintenance run --auto --quiet --detach` child. The child
	// outlives the fixture cell and writes inside `.git` (maintenance.lock,
	// packed-refs.lock, repack temp files), so the gating Unit shard failed in
	// `afterEach` teardown with ENOTEMPTY on the fixture `.git` instead of in an
	// assertion. A fixture never needs background maintenance, so the global
	// config the helper hands every fixture Git process is the checked-in policy
	// that turns it off.
	it("forks no detached auto-maintenance child from a fixture commit (#4552)", () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mjs-git-maintenance-"),
		);
		scratch.push(repo);
		const trace = path.join(repo, "trace2.json");
		const commit = () =>
			gitExecFileSync(
				[
					"-C",
					repo,
					"-c",
					"user.name=pi-lens-test",
					"-c",
					"user.email=pi-lens-test@example.com",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"fixture",
				],
				{ cwd: repo, stdio: "ignore", env: { GIT_TRACE2_EVENT: trace } },
			);
		gitExecFileSync(["init", "-q", "--initial-branch=main"], {
			cwd: repo,
			stdio: "ignore",
			env: { GIT_TRACE2_EVENT: trace },
		});
		commit();
		const events = fs.readFileSync(trace, "utf8");
		// The trace must have captured this commit, or the assertion below would
		// pass on an empty or unrelated trace.
		expect(events).toContain('"name":"commit"');
		// `child_start` is written by the parent before the fork, so it is in the
		// file even though the child is detached.
		const maintenance = events
			.split("\n")
			.filter((line) => line.includes('"child_start"'))
			.filter((line) => line.includes("maintenance"));
		expect(maintenance).toEqual([]);
	});

	// The TypeScript twin carries the same policy (#4552): a fixture that ran
	// through only one of the two helpers would still fork the detached child.
	it("carries the same no-background-maintenance policy in the TypeScript twin", () => {
		const jsEnv = envFor("C:/tmp", {});
		const tsEnv = gitFixtureEnv("C:/tmp");
		expect(tsEnv.GIT_CONFIG_GLOBAL).toBe(jsEnv.GIT_CONFIG_GLOBAL);
		expect(tsEnv.GIT_CONFIG_GLOBAL).toContain("git-fixture-global.gitconfig");
		expect(fs.existsSync(tsEnv.GIT_CONFIG_GLOBAL)).toBe(true);
		// The policy file itself, read the way git reads it.
		expect(fs.readFileSync(tsEnv.GIT_CONFIG_GLOBAL, "utf8")).toMatch(
			/\[maintenance\]\s*\n\s*auto = false/,
		);
		expect(tsEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
	});

	it("keeps exec and shell wrappers inside a throwaway repository", () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mjs-git-wrapper-"),
		);
		scratch.push(repo);
		gitExecFileSync(["init", "-q"], { cwd: repo, stdio: "ignore" });
		fs.writeFileSync(path.join(repo, "file.txt"), "fixture\n");
		expect(
			String(
				gitExecSync("git status --porcelain", { cwd: repo, encoding: "utf8" }),
			),
		).toContain("file.txt");
		expect(() =>
			gitExecFileSync(["config", "--get", "user.name"], { cwd: repo }),
		).toThrow();
	});
});
// flake-shape: real-process-spawn — real git fixture children resolve sanitized environment variables and repository metadata
