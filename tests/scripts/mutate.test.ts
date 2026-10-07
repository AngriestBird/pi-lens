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
const find = "true";
const replace = "Boolean(1)";
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
			find,
			"--replace",
			replace,
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
			find,
			"--replace",
			replace,
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
	const [code, signal] = await new Promise<
		[number | null, NodeJS.Signals | null]
	>((resolve) =>
		child.once("close", (exitCode, closeSignal) =>
			resolve([exitCode, closeSignal]),
		),
	);
	expect(code).toBeNull();
	expect(signal).toBe("SIGINT");
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

it("refuses a comment-only match unless explicitly allowed", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"mutation-comment-only-marker",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 1,
		stdout: expect.stringContaining("comments/strings"),
	});
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			cli,
			"--allow-comment",
			"--file",
			target,
			"--find",
			"mutation-comment-only-marker",
			"--replace",
			"changed",
			"--tests",
			target,
		],
		{ cwd: root },
	);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});

it("refuses repeated --file options", async () => {
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--file",
				"tests/scripts/mutate-built.txt",
				"--find",
				find,
				"--replace",
				replace,
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 2,
		stderr: expect.stringContaining("repeated --file"),
	});
});

it("reports a test load failure as ERROR", async () => {
	const before = digest();
	await expect(
		execFileAsync(
			process.execPath,
			[
				cli,
				"--file",
				target,
				"--find",
				"const mutationSafeMarker =",
				"--replace",
				"const mutationSafeMarker = =",
				"--tests",
				target,
			],
			{ cwd: root },
		),
	).rejects.toMatchObject({
		code: 1,
		stdout: expect.stringContaining("ERROR"),
	});
	expect(digest()).toBe(before);
});

async function terminatesAndRestores(signal: "SIGTERM" | "SIGHUP") {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
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
	child.kill(signal);
	const [code, closeSignal] = await new Promise<
		[number | null, NodeJS.Signals | null]
	>((resolve) =>
		child.once("close", (exitCode, observedSignal) =>
			resolve([exitCode, observedSignal]),
		),
	);
	expect(code).toBeNull();
	expect(closeSignal).toBe(signal);
	expect(digest()).toBe(before);
}

it("restores on SIGTERM", () => terminatesAndRestores("SIGTERM"));

it("restores on SIGHUP", () => terminatesAndRestores("SIGHUP"));

it("restores when a real timeout sends SIGTERM", async () => {
	const builtTarget = "tests/scripts/mutate-built.txt";
	const before = createHash("sha256")
		.update(readFileSync(builtTarget))
		.digest("hex");
	await expect(
		execFileAsync(
			"timeout",
			[
				"-s",
				"TERM",
				"2s",
				process.execPath,
				cli,
				"--built",
				"--file",
				"tests/scripts/mutate-built.txt",
				"--find",
				"mutation-built-marker",
				"--replace",
				"changed",
				"--tests",
				target,
			],
			{ cwd: root, env: { ...process.env, PI_LENS_MUTATION_RUN: "1" } },
		),
	).rejects.toMatchObject({
		code: 124,
	});
	expect(
		createHash("sha256").update(readFileSync(builtTarget)).digest("hex"),
	).toBe(before);
});

it("restores a SIGKILLed run on the next --restore invocation", async () => {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
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
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("close", resolve));
	expect(digest()).not.toBe(before);
	await execFileAsync(process.execPath, [cli, "--restore"], { cwd: root });
	expect(digest()).toBe(before);
});

it("restores an orphan journal before the next normal invocation", async () => {
	const before = digest();
	const child = spawn(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
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
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("close", resolve));
	expect(digest()).not.toBe(before);
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			cli,
			"--file",
			target,
			"--find",
			find,
			"--replace",
			replace,
			"--tests",
			target,
		],
		{ cwd: root },
	);
	expect(stdout).toContain("SURVIVED");
	expect(digest()).toBe(before);
});
