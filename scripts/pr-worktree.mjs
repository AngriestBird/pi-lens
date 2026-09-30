#!/usr/bin/env node
/**
 * scripts/pr-worktree.mjs (#3723)
 *
 * One command for the review / trailing-commit worktree sequence the
 * orchestrator and its reviewers repeat many times a day:
 *
 *   node scripts/pr-worktree.mjs open <PR|branch> [--merge|--head] [--name NAME]
 *   node scripts/pr-worktree.mjs close <path>
 *
 * `open` resolves a PR head via `gh pr view --json
 * headRefName,headRepositoryOwner,isCrossRepository`, fetches `pull/<n>/head`
 * (or `pull/<n>/merge` under `--merge`) from `origin`, creates a worktree
 * under `~/Desktop/pi-lens-worktrees/<name>`, and symlinks the main
 * checkout's `node_modules`. It prints the absolute path.
 *
 * `close` lstat's the worktree's `node_modules`: a symlink is unlinked, a
 * real directory is a refusal (never `rm -rf`, the #2704 class), and only
 * then does `git worktree remove` run; finally the local branch `open`
 * created is deleted. A branch the caller already owned is left in place.
 *
 * The close decision is a pure function of a table in
 * scripts/lib/pr-worktree.mjs; this file owns only the I/O. `run()` is
 * exported with injectable `gitExec`/`ghExec`/sinks so the process boundary
 * is observable; `main()` is the real entry point. `PI_LENS_GH_JSON` injects
 * the `gh` lookup's JSON for tests and CI, and `PI_LENS_WORKTREES_ROOT`
 * overrides the destination root -- both unset in normal use.
 *
 * The Bash guard (scripts/hooks/guard-bash.mjs) denies a hand-typed `git
 * worktree remove` on a tree whose `node_modules` is an outside symlink; this
 * tool is the sanctioned form of that sequence and is listed in the hook
 * suite's allow corpus (tests/scripts/guard-bash-hook.test.ts).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	classifyNodeModules,
	deriveClosePlan,
	deriveOpenPlan,
	worktreeBranchName,
} from "./lib/pr-worktree.mjs";

const USAGE = [
	"usage:",
	"  node scripts/pr-worktree.mjs open <PR|branch> [--merge|--head] [--name NAME]",
	"  node scripts/pr-worktree.mjs close <path>",
].join("\n");

/** @param {string[]} args @param {{cwd?: string}} [options] */
function defaultGitExec(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/** @param {string[]} args @param {{cwd?: string}} [options] */
function defaultGhExec(args, options = {}) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

/**
 * Destination root for opened worktrees. `PI_LENS_WORKTREES_ROOT` is the
 * CI/test override; the default is the maintainer's review root.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveWorktreesRoot(env = process.env) {
	const override = env.PI_LENS_WORKTREES_ROOT?.trim();
	if (override) return override;
	return path.join(os.homedir(), "Desktop", "pi-lens-worktrees");
}

/**
 * The repository's MAIN worktree root -- the first `worktree <path>` line of
 * `git worktree list --porcelain`, which is where the shared `node_modules`
 * lives. A linked worktree's own root is never a source for the symlink.
 *
 * @param {(args: string[], options?: {cwd?: string}) => string} gitExec
 * @param {string} cwd
 * @returns {string|null}
 */
function mainWorktreeRoot(gitExec, cwd) {
	const out = gitExec(["worktree", "list", "--porcelain"], { cwd });
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith("worktree "))
			return line.slice("worktree ".length).trim();
	}
	return null;
}

/**
 * @param {string[]} argv
 * @returns {{ command: string|null, target: string|null, mode: string|null,
 *   name: string|null, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
	const [command = null, ...rest] = argv;
	const options = {
		command,
		target: null,
		mode: null,
		name: null,
		help: false,
		errors: [],
	};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--merge" || arg === "--head") {
			options.mode = arg.slice(2);
			continue;
		}
		if (arg === "--name") {
			options.name = rest[++index] ?? null;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg.startsWith("--")) {
			options.errors.push(`unknown option ${arg}`);
			continue;
		}
		if (options.target === null) {
			options.target = arg;
			continue;
		}
		options.errors.push(`unexpected argument ${arg}`);
	}
	return options;
}

/**
 * @param {string} prNumber
 * @param {NodeJS.ProcessEnv} env
 * @param {(args: string[], options?: {cwd?: string}) => string} ghExec
 * @param {string} cwd
 * @returns {{ headRefName?: string|null }}
 */
function resolvePrHead(prNumber, env, ghExec, cwd) {
	const injected = env.PI_LENS_GH_JSON?.trim();
	const raw =
		injected ??
		ghExec(
			[
				"pr",
				"view",
				prNumber,
				"--json",
				"headRefName,headRepositoryOwner,isCrossRepository",
			],
			{ cwd },
		);
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`gh pr view ${prNumber} returned unparseable JSON`);
	}
}

/**
 * @param {{ target: string, mode: string|null, name: string|null }} options
 * @param {object} io
 * @returns {number}
 */
function executeOpen(options, io) {
	const { gitExec, ghExec, env, cwd, stdout, stderr, worktreesRoot } = io;
	const numeric = /^\d+$/.test(options.target);
	let prHead = null;
	if (numeric) {
		try {
			prHead = resolvePrHead(options.target, env, ghExec, cwd);
		} catch (error) {
			stderr(`failed to resolve PR ${options.target}: ${error.message}`);
			return 1;
		}
	}
	const plan = deriveOpenPlan({
		target: options.target,
		mode: options.mode,
		name: options.name,
		worktreesRoot,
		prHead,
	});
	if (!plan.ok) {
		stderr(plan.error);
		return 2;
	}
	try {
		if (plan.fetchRefspec) {
			gitExec(["fetch", "origin", plan.fetchRefspec], { cwd });
		}
		fs.mkdirSync(worktreesRoot, { recursive: true });
		const addArgs = ["worktree", "add"];
		if (plan.branch) addArgs.push("-b", plan.branch);
		addArgs.push(plan.path, plan.commitish);
		gitExec(addArgs, { cwd });
	} catch (error) {
		stderr(`failed to create worktree ${plan.path}: ${error.message}`);
		return 1;
	}
	const mainRoot = mainWorktreeRoot(gitExec, cwd);
	if (mainRoot) {
		const source = path.join(mainRoot, "node_modules");
		const link = path.join(plan.path, "node_modules");
		let linkExists = false;
		try {
			fs.lstatSync(link);
			linkExists = true;
		} catch {
			linkExists = false;
		}
		if (!linkExists && fs.existsSync(source)) {
			try {
				fs.symlinkSync(source, link);
			} catch (error) {
				stderr(`warning: could not symlink node_modules: ${error.message}`);
			}
		}
	}
	stdout(plan.path);
	return 0;
}

/**
 * @param {{ target: string }} options
 * @param {object} io
 * @returns {number}
 */
function executeClose(options, io) {
	const { gitExec, cwd, stdout, stderr } = io;
	const worktreePath = path.resolve(cwd, options.target);
	let registered;
	try {
		registered = mainWorktreeRoots(gitExec, cwd);
	} catch (error) {
		stderr(`failed to list worktrees: ${error.message}`);
		return 1;
	}
	if (!registered.some((entry) => path.resolve(entry) === worktreePath)) {
		stderr(`not a registered worktree: ${worktreePath}`);
		return 2;
	}
	const nodeModulesPath = path.join(worktreePath, "node_modules");
	let entry = null;
	try {
		entry = fs.lstatSync(nodeModulesPath);
	} catch {
		entry = null;
	}
	const branch = worktreeBranchName(worktreePath);
	let branchExists = false;
	try {
		gitExec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
			cwd,
		});
		branchExists = true;
	} catch {
		branchExists = false;
	}
	const plan = deriveClosePlan({
		worktreePath,
		nodeModulesKind: classifyNodeModules(entry),
		branchExists,
	});
	if (!plan.ok) {
		stderr(plan.error);
		return 1;
	}
	if (plan.unlinkNodeModules) {
		try {
			fs.unlinkSync(nodeModulesPath);
		} catch (error) {
			stderr(`failed to unlink symlinked node_modules: ${error.message}`);
			return 1;
		}
	}
	try {
		gitExec(["worktree", "remove", worktreePath], { cwd });
	} catch (error) {
		stderr(`failed to remove worktree ${worktreePath}: ${error.message}`);
		return 1;
	}
	if (plan.branchToDelete) {
		try {
			gitExec(["branch", "-D", plan.branchToDelete], { cwd });
		} catch (error) {
			stderr(
				`warning: could not delete ${plan.branchToDelete}: ${error.message}`,
			);
		}
	}
	stdout(worktreePath);
	return 0;
}

/**
 * Every registered worktree root, in `git worktree list --porcelain` order.
 *
 * @param {(args: string[], options?: {cwd?: string}) => string} gitExec
 * @param {string} cwd
 * @returns {string[]}
 */
function mainWorktreeRoots(gitExec, cwd) {
	const out = gitExec(["worktree", "list", "--porcelain"], { cwd });
	const roots = [];
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith("worktree "))
			roots.push(line.slice("worktree ".length).trim());
	}
	return roots;
}

/**
 * The whole CLI, resolving an exit code instead of touching `process` so a
 * test can drive it through the real entry function with injected command
 * boundaries.
 *
 * @param {{ argv?: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 *   gitExec?: (args: string[], options?: {cwd?: string}) => string,
 *   ghExec?: (args: string[], options?: {cwd?: string}) => string,
 *   stdout?: (message: string) => void, stderr?: (message: string) => void }} [options]
 * @returns {number}
 */
export function run({
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	env = process.env,
	gitExec = defaultGitExec,
	ghExec = defaultGhExec,
	stdout = console.log,
	stderr = console.error,
} = {}) {
	const options = parseArgs(argv);
	if (options.help) {
		stdout(USAGE);
		return 0;
	}
	if (!options.command || options.errors.length > 0) {
		for (const message of options.errors) stderr(message);
		stderr(USAGE);
		return 2;
	}
	if (options.command !== "open" && options.command !== "close") {
		stderr(`unknown command ${options.command}`);
		stderr(USAGE);
		return 2;
	}
	if (!options.target) {
		stderr(USAGE);
		return 2;
	}
	let repoRoot;
	try {
		repoRoot = gitExec(["rev-parse", "--show-toplevel"], { cwd }).trim();
	} catch (error) {
		stderr(`not a git repository: ${error.message}`);
		return 2;
	}
	const io = {
		gitExec,
		ghExec,
		env,
		cwd: repoRoot,
		stdout,
		stderr,
		worktreesRoot: resolveWorktreesRoot(env),
	};
	return options.command === "open"
		? executeOpen(options, io)
		: executeClose(options, io);
}

/** The real entry point: exit code only, so `run` stays process-free. */
export function main() {
	process.exitCode = run();
}

const ENTRY = process.argv[1]
	? pathToFileURL(process.argv[1]).href === import.meta.url
	: false;
if (ENTRY) main();
