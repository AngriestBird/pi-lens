/**
 * #4941: the commit gate judges the working tree being committed.
 *
 * RECURRENCE GUARDED (file level): the gate's blocker state was one
 * process-wide latch (`_gitGuardHasBlockers`, `_gitGuardSummary`) beside two
 * more process-wide latches (`_gitGuardCacheUnknownReason`,
 * `_gitGuardUnansweredDispatches`) and a scan of every record's suppression
 * verdict, so a commit in repository B was refused for a blocker, a stored
 * record or an unanswered dispatch in repository A (census C3, tier 2:
 * `tests/index-4941-commit-gate-by-repo.test.ts`). These cases pin each reader
 * and, in `resolveCommitScope`, the one question that decides which tree a
 * command targets, with a real `RuntimeCoordinator` and real git
 * repositories. A form the scope does not read must judge EVERY blocker
 * (AGENTS.md: gates fail closed), so most rows below are refusals to scope.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	evaluateGitGuard,
	resolveCommitScope,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { execFileSync } from "../support/git-fixture-env.js";
import { setupTestEnvironment } from "./test-utils.js";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A git repository (real path) holding `src/<name>.ts` for each name. */
function repo(root: string, name: string, files: string[] = ["a"]): string {
	const dir = path.join(fs.realpathSync.native(root), name);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	for (const file of files) {
		fs.writeFileSync(
			path.join(dir, "src", `${file}.ts`),
			"export const x = 1;\n",
		);
	}
	git(dir, ["init", "-q"]);
	return dir;
}

const COMMIT = { toolName: "bash", input: { command: "git commit -m wip" } };

function commit(command: string) {
	return { toolName: "bash", input: { command } };
}

/** The blocker a write records, with the verdict `tool_result` latches. */
function blockerIn(runtime: RuntimeCoordinator, file: string, summary: string) {
	const bytes = fs.readFileSync(file);
	runtime.recordInlineBlockers(file, summary, undefined, ["tsc"], [1], {
		size: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	runtime.updateGitGuardStatus(true, summary, file);
}

function verdictOf(
	runtime: RuntimeCoordinator,
	cwd: string,
	invocation: { toolName: string; input: unknown } | undefined,
) {
	return evaluateGitGuard(
		runtime,
		new CacheManager(false),
		cwd,
		"pi",
		undefined,
		invocation,
	);
}

describe("#4941: the commit gate's blocker state is read per working tree", () => {
	it("refuses a commit in the repository with the blocker, names its summary, and allows another repository", () => {
		// RECURRENCE GUARDED: #4941: the latch refused repository B for A's blocker.
		const env = setupTestEnvironment("pi-lens-4941-latch-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("blocker in A");
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
			// A form the scope does not read is judged by every blocker.
			expect(verdictOf(runtime, repoB, undefined).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("names only the committed repository's blocker when both hold one", () => {
		// RECURRENCE GUARDED: #4941: the refusal's summary named a foreign file.
		const env = setupTestEnvironment("pi-lens-4941-summary-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			blockerIn(runtime, path.join(repoB, "src", "a.ts"), "blocker in B");
			const inB = verdictOf(runtime, repoB, COMMIT);
			expect(inB.reason).toContain("blocker in B");
			expect(inB.reason).not.toContain("blocker in A");
		} finally {
			env.cleanup();
		}
	});

	it("scopes a retargeted commit (git -C) to the repository it names", () => {
		// RECURRENCE GUARDED: #4941: keying by the session's cwd would let
		// `git -C <repo-with-blocker> commit` run from a clean repository.
		const env = setupTestEnvironment("pi-lens-4941-dash-c-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			expect(
				verdictOf(runtime, repoB, commit(`git -C ${repoA} commit -m wip`))
					.block,
			).toBe(true);
			expect(
				verdictOf(runtime, repoA, commit(`git -C ${repoB} commit -m wip`)),
			).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("keeps a repository-less verdict a blocker for every tree", () => {
		// RECURRENCE GUARDED: #4941's fail-closed side: a verdict that names no
		// file (`updateGitGuardStatus(true, …)`) belongs to no tree to exclude.
		const env = setupTestEnvironment("pi-lens-4941-verdict-");
		try {
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.updateGitGuardStatus(true, "a verdict with no file");
			expect(verdictOf(runtime, repoB, COMMIT).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("scopes a stale suppression verdict to its own repository", () => {
		// RECURRENCE GUARDED: #4941: `firstExpiredSuppressionVerdict` scanned
		// every record, so A's moved-on suppression refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-stale-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			const file = path.join(repoA, "src", "a.ts");
			blockerIn(runtime, file, "blocker in A");
			runtime.applyInlineBlockerPolicyVerdicts([file]);
			runtime.updateGitGuardStatus(false, "");
			fs.writeFileSync(file, "export const x = 2;\n");
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("inline_policy_stale");
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("scopes a dispatch that never answered to its own repository", () => {
		// RECURRENCE GUARDED: #4941: `gitGuardUnansweredDispatches.find` read
		// the whole process, so A's crashed dispatch refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-unanswered-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardDispatchUnanswered(
				path.join(repoA, "src", "a.ts"),
				"pipeline_crash",
			);
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("pipeline_crash");
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("scopes a latched record failure to the project it is about, and keeps one with no project global", () => {
		// RECURRENCE GUARDED: #4941: `gitGuardCacheUnknownReason` was one slot
		// for the process, so A's failed record write refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-cache-unknown-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardCacheUnknown("cache_write_failed", repoA);
			expect(verdictOf(runtime, repoA, COMMIT).block).toBe(true);
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
			runtime.markGitGuardCacheUnknown("cache_write_failed");
			expect(verdictOf(runtime, repoB, COMMIT).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4941: resolveCommitScope reads only forms it can place in a tree", () => {
	function scopeOf(command: string, cwd: string) {
		return resolveCommitScope("bash", { command }, cwd);
	}

	it("places a plain commit, push or chained commit in the repository of the cwd", () => {
		const env = setupTestEnvironment("pi-lens-4941-scope-plain-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const inA = path.join(repoA, "src", "a.ts");
			const inB = path.join(repoB, "src", "a.ts");
			for (const command of [
				"git commit -m wip",
				"git push origin main",
				'git commit -m "wip"; echo done',
				"git add -A && git commit -m wip",
				"git status\ngit commit -m wip",
				`git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
			]) {
				const scope = scopeOf(command, repoA);
				expect(scope?.contains(inA), command).toBe(true);
				expect(scope?.contains(inB), command).toBe(false);
			}
		} finally {
			env.cleanup();
		}
	});

	it("places the directory a git -C names, and a subdirectory in its repository", () => {
		const env = setupTestEnvironment("pi-lens-4941-scope-c-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const viaDashC = scopeOf(`git -C ${repoB} commit -m wip`, repoA);
			expect(viaDashC?.contains(path.join(repoB, "src", "a.ts"))).toBe(true);
			expect(viaDashC?.contains(path.join(repoA, "src", "a.ts"))).toBe(false);
			const relative = scopeOf("git -C ../b commit -m wip", repoA);
			expect(relative?.contains(path.join(repoB, "src", "a.ts"))).toBe(true);
			const fromSubdirectory = scopeOf(
				"git commit -m wip",
				path.join(repoA, "src"),
			);
			expect(fromSubdirectory?.contains(path.join(repoA, "src", "a.ts"))).toBe(
				true,
			);
			// A file that no longer exists still belongs to the tree above it.
			expect(
				fromSubdirectory?.contains(
					path.join(repoA, "src", "deleted", "gone.ts"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves every other form unscoped, so the gate judges every blocker", () => {
		// RECURRENCE GUARDED: #4941's fail-closed side. Each row moves the
		// commit's directory or environment, or hides where it goes, in a way a
		// scope read from the cwd would miss: `cd B && git commit` from a clean
		// repository would commit over B's blocker.
		const env = setupTestEnvironment("pi-lens-4941-scope-open-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const notARepo = path.join(fs.realpathSync.native(env.tmpDir), "plain");
			fs.mkdirSync(notARepo, { recursive: true });
			for (const command of [
				`cd ${repoB} && git commit -m wip`,
				`(cd ${repoB}; git commit -m wip)`,
				`pushd ${repoB} && git commit -m wip`,
				`export GIT_DIR=${repoB}/.git; git commit -m wip`,
				`GIT_DIR=${repoB}/.git git commit -m wip`,
				`git --git-dir=${repoB}/.git commit -m wip`,
				`git --work-tree=${repoB} commit -m wip`,
				`git -c core.worktree=${repoB} commit -m wip`,
				`git -C${repoB} commit -m wip`,
				'git -C "$target" commit -m wip',
				"git -C ~/nowhere commit -m wip",
				`git -C ${path.join(repoB, "missing")} commit -m wip`,
				"npm test && git commit -m wip",
				"git commit -m wip 2>&1 | tail -3",
				'bash -c "git commit -m wip"',
				"xargs git commit -m wip",
				"env FOO=1 git commit -m wip",
				`git commit -m "$(cd ${repoB} && git commit -m inner)"`,
				"$GIT commit -m wip",
				"git status",
				"echo hello",
			]) {
				expect(scopeOf(command, repoA), command).toBeUndefined();
			}
			expect(scopeOf("git commit -m wip", notARepo)).toBeUndefined();
			expect(
				resolveCommitScope("write", { command: "git commit" }, repoA),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("tells a linked worktree from the checkout it sits in", () => {
		// RECURRENCE GUARDED: #4941: this repository keeps agent worktrees under
		// `.claude/worktrees/`, a path inside the main checkout that shares no
		// working file with it; containment would gate the wrong tree.
		const env = setupTestEnvironment("pi-lens-4941-scope-worktree-");
		try {
			const main = repo(env.tmpDir, "main");
			git(main, ["add", "-A"]);
			git(main, [
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t.local",
				"commit",
				"-qm",
				"base",
			]);
			const linked = path.join(main, ".claude", "worktrees", "w1");
			git(main, ["worktree", "add", "-q", linked, "-b", "w1"]);
			const inMain = path.join(main, "src", "a.ts");
			const inLinked = path.join(linked, "src", "a.ts");
			const fromLinked = scopeOf("git commit -m wip", linked);
			expect(fromLinked?.contains(inLinked)).toBe(true);
			expect(fromLinked?.contains(inMain)).toBe(false);
			const fromMain = scopeOf("git commit -m wip", main);
			expect(fromMain?.contains(inMain)).toBe(true);
			expect(fromMain?.contains(inLinked)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
