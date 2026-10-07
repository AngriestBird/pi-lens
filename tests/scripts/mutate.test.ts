// flake-shape: real-process-spawn — the mutation CLI's child Vitest process and SIGINT restoration are the process boundary under test.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cli = "scripts/mutate.mjs";
const target = "tests/scripts/mutate-fixture.test.ts";
const digest = () =>
	createHash("sha256").update(readFileSync(target)).digest("hex");

function invoke(testFile: string, ...extra: string[]) {
	return execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			"mutation-safe-marker",
			"--replace",
			"changed",
			"--tests",
			testFile,
			...extra,
		],
		{ cwd: root },
	);
}

function invokeNoop() {
	return execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			"missing",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{ cwd: root },
	);
}

it("restores the source after a successful test run and reports SURVIVED", async () => {
	const before = digest();
	const { stdout } = await invoke(target);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});

it("restores the source after a failing test run and reports RED with a title", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"mutation-fail-marker",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({ code: 1 });
	expect(digest()).toBe(before);
});

it("restores after a mutation throw", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"/[",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({ code: 1 });
	expect(digest()).toBe(before);
});

it("refuses a no-op and leaves the source untouched", async () => {
	const before = digest();
	await expect(invokeNoop()).rejects.toMatchObject({ code: 1 });
	expect(digest()).toBe(before);
});

it("restores on SIGINT", async () => {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			"mutation-safe-marker",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{
			cwd: root,
			env: { ...process.env, PI_LENS_MUTATION_RUN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	child.kill("SIGINT");
	const code = await new Promise((resolve) => child.once("close", resolve));
	expect(code).toBe(130);
	expect(digest()).toBe(before);
});

it("supports a surviving built-twin mutation", async () => {
	const builtTarget = "tests/scripts/mutate-built.txt";
	const before = createHash("sha256")
		.update(readFileSync(builtTarget))
		.digest("hex");
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			cli,
			"--built",
			"--file",
			builtTarget,
			"--find",
			"mutation-built-marker",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{ cwd: root },
	);
	expect(stdout).toContain("SURVIVED");
	expect(
		createHash("sha256").update(readFileSync(builtTarget)).digest("hex"),
	).toBe(before);
});
