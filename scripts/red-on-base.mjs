import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Decide which of the three observed run states explains a red. */
export function decideVerdict({ head, base, isolation }) {
	const failingNames = [
		...new Set([...head.names, ...base.names, ...isolation.names]),
	];
	if (isolation.passed) return { verdict: "ISOLATION-GREEN", failingNames };
	if (!head.passed && base.passed)
		return { verdict: "CAUSED-BY-CHANGE", failingNames };
	return { verdict: "RED-ON-BASE", failingNames };
}

function parseArgs(argv) {
	const files = [];
	let base = "origin/master";
	let repeat = 1;
	let testCommand;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base") base = argv[++index];
		else if (arg === "--repeat") repeat = Number(argv[++index]);
		else if (arg === "--test-command") testCommand = argv[++index];
		else files.push(arg);
	}
	if (!files.length)
		throw new Error(
			"usage: node scripts/red-on-base.mjs <test files…> [--base ref] [--repeat N]",
		);
	if (!Number.isInteger(repeat) || repeat < 1)
		throw new Error("--repeat must be a positive integer");
	return { files, base, repeat, testCommand };
}

function failingNames(output) {
	return [
		...new Set(
			output.split(/\r?\n/).flatMap((line) => {
				const match = line.match(/^\s*(?:FAIL|[×✗])\s+(.+?)\s*$/);
				if (match) return [match[1]];
				const fake = line.match(/^\s*failing test:\s*(.+?)\s*$/i);
				return fake ? [fake[1]] : [];
			}),
		),
	];
}

function runTests({ cwd, files, repeat, testCommand, env }) {
	let passed = true;
	const names = [];
	for (let attempt = 0; attempt < repeat; attempt += 1) {
		const command = testCommand ?? resolve(cwd, "node_modules/.bin/vitest");
		const commandArgs = testCommand?.endsWith(".mjs")
			? [testCommand, ...files]
			: ["run", ...files];
		const result = spawnSync(
			testCommand?.endsWith(".mjs") ? process.execPath : command,
			commandArgs,
			{
				cwd,
				env: { ...env, PI_LENS_TEST_MAX_WORKERS: "6" },
				encoding: "utf8",
			},
		);
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (result.status !== 0) passed = false;
		names.push(...failingNames(output));
	}
	return { passed, names: [...new Set(names)] };
}

function git(args, cwd, env) {
	return execFileSync("git", args, {
		cwd,
		env,
		stdio: "pipe",
		encoding: "utf8",
	});
}

function baseWorktree({ cwd, base, root, env }) {
	const worktree = mkdtempSync(join(root, "base-"));
	let added = false;
	let linked = false;
	const nodeModules = join(worktree, "node_modules");
	try {
		git(["worktree", "add", "--detach", worktree, base], cwd, env);
		added = true;
		symlinkSync(resolve(cwd, "node_modules"), nodeModules, "dir");
		linked = true;
		const build = spawnSync("npm", ["run", "build"], {
			cwd: worktree,
			env: { ...env, PI_LENS_TEST_MAX_WORKERS: "6" },
			stdio: "inherit",
		});
		if (build.status !== 0)
			throw new Error(`base build failed with status ${build.status}`);
		return { worktree, nodeModules, linked };
	} catch (error) {
		if (linked && existsSync(nodeModules)) unlinkSync(nodeModules);
		if (added) git(["worktree", "remove", "--force", worktree], cwd, env);
		rmSync(worktree, { recursive: true, force: true });
		throw error;
	}
}

function removeBaseWorktree({ cwd, env, worktree, nodeModules, linked }) {
	// The symlink must be gone before git sees the worktree; git's forced remove
	// otherwise follows it and can delete the shared install (#3173).
	if (linked && existsSync(nodeModules)) unlinkSync(nodeModules);
	git(["worktree", "remove", "--force", worktree], cwd, env);
	rmSync(worktree, { recursive: true, force: true });
}

export function main(argv = process.argv.slice(2)) {
	const { files, base, repeat, testCommand } = parseArgs(argv);
	const cwd = process.cwd();
	const configuredTmp = process.env.TMPDIR || tmpdir();
	const runRoot = mkdtempSync(join(configuredTmp, "pi-lens-red-on-base-"));
	const home = join(runRoot, "home");
	const baseHome = join(runRoot, "base-home");
	mkdirSync(home);
	mkdirSync(baseHome);
	const env = { ...process.env, TMPDIR: configuredTmp, PI_LENS_HOME: home };
	let baseState;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (baseState) removeBaseWorktree({ cwd, env, ...baseState });
		rmSync(runRoot, { recursive: true, force: true });
	};
	const onSignal = () => {
		cleanup();
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const head = runTests({ cwd, files, repeat, testCommand, env });
		baseState = baseWorktree({ cwd, base, root: runRoot, env });
		const baseResult = runTests({
			cwd: baseState.worktree,
			files,
			repeat,
			testCommand,
			env: { ...env, PI_LENS_HOME: baseHome },
		});
		const isolation = runTests({ cwd, files, repeat, testCommand, env });
		const result = decideVerdict({ head, base: baseResult, isolation });
		console.log(result.verdict);
		for (const name of result.failingNames)
			console.log(`failing test: ${name}`);
		return result.verdict === "ISOLATION-GREEN" ? 0 : 1;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		cleanup();
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
	process.exitCode = main();
