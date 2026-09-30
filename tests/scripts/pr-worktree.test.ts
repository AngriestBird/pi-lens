// flake-shape: real-process-spawn — the subject IS the script's own process
// entry: a real `git` fixture's worktree registry, the real on-disk
// `node_modules` symlink, and the real exit code decide open/close; an
// in-process double restates none of those command boundaries.
/**
 * Tests for scripts/pr-worktree.mjs (#3723).
 *
 * The dangerous half of `close` is the decision — unlink only a symlink,
 * refuse a real directory, never touch the link target — and that decision
 * lives in scripts/lib/pr-worktree.mjs so it is provable without a
 * filesystem. These cases drive BOTH layers: the pure planner directly, and
 * the real CLI entry against a throwaway git fixture (no network; the `gh`
 * lookup is injected through `PI_LENS_GH_JSON`).
 *
 * The close guard is the #3173 / #2704 class: a `git worktree remove` on a
 * symlinked `node_modules` follows the link into the shared install on the
 * platforms where it bites, so `close` unlinks the symlink itself and refuses
 * a real directory rather than deleting it recursively.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyNodeModules,
	deriveClosePlan,
	deriveOpenPlan,
	worktreeBranchName,
} from "../../scripts/lib/pr-worktree.mjs";
import { run } from "../../scripts/pr-worktree.mjs";
import { gitFixtureEnv } from "../support/git-fixture-env.js";

const CLI = path.resolve(__dirname, "../../scripts/pr-worktree.mjs");
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git";

const createdRoots: string[] = [];

afterEach(() => {
	for (const dir of createdRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	root: string;
	repo: string;
	origin: string;
	worktreesRoot: string;
	head: string;
	git: (args: string[], cwd?: string) => string;
}

function makeFixture(): Fixture {
	const probeHome = path.join(process.cwd(), ".probe-home");
	fs.mkdirSync(probeHome, { recursive: true });
	const root = fs.mkdtempSync(path.join(probeHome, "pr-worktree-"));
	createdRoots.push(root);
	const repo = path.join(root, "main");
	const origin = path.join(root, "origin.git");
	const worktreesRoot = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	const git = (args: string[], cwd = repo) =>
		execFileSync(GIT, args, {
			cwd,
			env: gitFixtureEnv(root),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(["init", "-q", "-b", "master"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "pi-lens test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
	git(["add", "."]);
	git(["commit", "-qm", "init"]);
	// The main checkout's shared install, present before any open symlinks it.
	fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "node_modules", "shared-sentinel.txt"),
		"shared install\n",
	);
	git(["init", "-q", "--bare", "-b", "master", origin], root);
	git(["remote", "add", "origin", origin]);
	git(["push", "-q", "-u", "origin", "master"]);
	const head = git(["rev-parse", "HEAD"]).trim();
	// GitHub's pull/<n>/{head,merge} refs, mirrored into the throwaway origin
	// so the fetch path is exercised with no network.
	git(["-C", origin, "update-ref", "refs/pull/9001/head", head]);
	git(["-C", origin, "update-ref", "refs/pull/9001/merge", head]);
	return { root, repo, origin, worktreesRoot, head, git };
}

function runCli(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: fixture.repo,
		env: {
			...gitFixtureEnv(fixture.root),
			PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			...extraEnv,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

function runCliResult(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
	try {
		return { status: 0, stdout: runCli(fixture, args, extraEnv), stderr: "" };
	} catch (error) {
		const failure = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: failure.status ?? 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

const PR_HEAD_JSON = JSON.stringify({
	headRefName: "fix/thing",
	headRepositoryOwner: { login: "apmantza" },
	isCrossRepository: false,
});

describe("pr-worktree planner (pure)", () => {
	it("classifies a missing, symlinked, and real node_modules distinctly", () => {
		expect(classifyNodeModules(null)).toBe("missing");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => true,
				isDirectory: () => false,
			}),
		).toBe("symlink");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => false,
				isDirectory: () => true,
			}),
		).toBe("directory");
	});

	it("refuses close on a real directory and unlinks only a symlink", () => {
		const refused = deriveClosePlan({
			worktreePath: path.join("w", "review-1"),
			nodeModulesKind: "directory",
			branchExists: true,
		});
		expect(refused.ok).toBe(false);
		const allowed = deriveClosePlan({
			worktreePath: path.join("w", "review-1"),
			nodeModulesKind: "symlink",
			branchExists: true,
		});
		expect(allowed).toMatchObject({
			ok: true,
			unlinkNodeModules: true,
			branchToDelete: "pr-worktree/review-1",
		});
	});

	it("derives PR-head, PR-merge, and branch open plans", () => {
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "head",
				name: null,
				worktreesRoot: "w",
				prHead: { headRefName: "fix/thing" },
			}),
		).toMatchObject({
			ok: true,
			name: "pr-9001-fix-thing",
			branch: "pr-worktree/pr-9001-fix-thing",
			fetchRefspec: "pull/9001/head",
		});
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "merge",
				name: "review-2",
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "review-2",
			fetchRefspec: "pull/9001/merge",
		});
		expect(
			deriveOpenPlan({
				target: "fix/other",
				mode: null,
				name: null,
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "fix-other",
			branch: null,
			fetchRefspec: null,
			commitish: "fix/other",
		});
		expect(worktreeBranchName(path.join("w", "review-2"))).toBe(
			"pr-worktree/review-2",
		);
	});
});

describe("pr-worktree CLI open", () => {
	it("prints the absolute path, checks out the PR head, and links the shared install", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--head", "--name", "review-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "review-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		const link = path.join(worktree, "node_modules");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(link)).toBe(path.join(fixture.repo, "node_modules"));
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-1"]),
		).toContain("refs/heads/pr-worktree/review-1");
	});

	it("opens a PR merge ref through pull/<n>/merge", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--merge", "--name", "merge-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "merge-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/merge-1"]),
		).toContain("refs/heads/pr-worktree/merge-1");
	});
});

describe("pr-worktree CLI close", () => {
	it("unlinks a symlinked node_modules and leaves the link target untouched", () => {
		const fixture = makeFixture();
		const target = path.join(fixture.root, "link-target");
		fs.mkdirSync(path.join(target, "deep"), { recursive: true });
		fs.writeFileSync(path.join(target, "deep", "sentinel.txt"), "keep\n");
		const worktree = path.join(fixture.worktreesRoot, "review-2");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-2", worktree]);
		fs.symlinkSync(target, path.join(worktree, "node_modules"));

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(
			fs.readFileSync(path.join(target, "deep", "sentinel.txt"), "utf8"),
		).toBe("keep\n");
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-2"]),
		).toThrow();
	});

	it("refuses a real node_modules directory and leaves the worktree registered", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-3");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-3", worktree]);
		fs.mkdirSync(path.join(worktree, "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(worktree, "node_modules", "keep.txt"), "copy\n");

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing");
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fs.readFileSync(path.join(worktree, "node_modules", "keep.txt"), "utf8"),
		).toBe("copy\n");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			path.resolve(worktree),
		);
	});

	it("unlinks node_modules BEFORE git worktree remove (the #3173 ordering guard)", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-4");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-4", worktree]);
		fs.symlinkSync(
			path.join(fixture.repo, "node_modules"),
			path.join(worktree, "node_modules"),
		);
		let nodeModulesPresentAtRemove = true;
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				nodeModulesPresentAtRemove = fs.existsSync(
					path.join(worktree, "node_modules"),
				);
			}
			return execFileSync(GIT, args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				...options,
			});
		};
		const status = run({
			argv: ["close", worktree],
			cwd: fixture.repo,
			env: {
				...gitFixtureEnv(fixture.root),
				PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			} as NodeJS.ProcessEnv,
			gitExec,
			stdout: () => {},
			stderr: () => {},
		});

		expect(status).toBe(0);
		expect(nodeModulesPresentAtRemove).toBe(false);
	});
});
