// flake-shape: real-process-spawn — the one-fragment-per-PR check shells out to real `git` for the PR diff; a fixture repo's own git boundary cannot be proven in-process.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	addedChangelogFragments,
	checkChangelogFragments,
} from "../../scripts/check-changelog-fragments.mjs";
import { parseEntry } from "../../scripts/rollup-changelog.mjs";

const entriesDir = path.resolve(process.cwd(), ".changelog");

describe("changelog entry guard", () => {
	it("validates every checked-in entry file", () => {
		const files = fs
			.readdirSync(entriesDir)
			.filter((name) => name.endsWith(".md") && name !== "README.md");
		for (const file of files)
			expect(() =>
				parseEntry(fs.readFileSync(path.join(entriesDir, file), "utf8"), file),
			).not.toThrow();
	});
});

// #3795 item 2. Recurrence: fold rounds added a second `.changelog/` fragment
// to PRs that already had one (#3774, #3768), against the one-fragment-per-
// change rule. The fast-fail job validated each fragment's shape but never
// counted the PR diff's additions.
describe("one changelog fragment per PR (#3795)", () => {
	const fragment = (bullet: string) =>
		`---\nsection: Fixed\n---\n\n- ${bullet}\n`;
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const commit = (dir: string, message: string) => {
		gitExecFileSync(
			[
				"-c",
				"user.email=pi-lens-test@example.com",
				"-c",
				"user.name=pi-lens-test",
				"commit",
				"-qm",
				message,
			],
			{ cwd: dir },
		);
	};
	const makeRepo = () => {
		const dir = fs.mkdtempSync(
			path.join(process.cwd(), ".tmp-changelog-frag-"),
		);
		dirs.push(dir);
		gitExecFileSync(["init", "-q"], { cwd: dir });
		fs.mkdirSync(path.join(dir, ".changelog"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".changelog", "README.md"),
			"# Fragments\n",
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "base");
		return dir;
	};
	const addFragment = (dir: string, name: string, bullet: string) => {
		fs.writeFileSync(path.join(dir, ".changelog", name), fragment(bullet));
		gitExecFileSync(["add", "."], { cwd: dir });
	};
	const gitFor = (dir: string) => (args: string[]) =>
		gitExecFileSync(args, { cwd: dir });

	it("fails and names both when the PR diff adds two fragments", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "first change");
		addFragment(dir, "pr-b.md", "second change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			rootDir: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	it("accepts a PR diff that adds exactly one fragment", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "the only change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			rootDir: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("accepts a PR diff that adds no fragment", () => {
		const dir = makeRepo();
		fs.writeFileSync(path.join(dir, "notes.md"), "docs\n");
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			rootDir: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("counts additions from the merge-base when the named base is ahead", () => {
		const dir = makeRepo();
		const branchPoint = String(
			gitExecFileSync(["rev-parse", "HEAD"], { cwd: dir }),
		).trim();
		fs.writeFileSync(
			path.join(dir, ".changelog", "rollup.md"),
			fragment("already rolled up"),
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "rollup");
		gitExecFileSync(["branch", "rollup"], { cwd: dir });
		gitExecFileSync(["checkout", "-q", branchPoint], { cwd: dir });
		addFragment(dir, "pr-a.md", "the branch change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "rollup",
			cwd: dir,
			rootDir: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
		expect(result.fragments).toEqual([".changelog/pr-a.md"]);
	});

	it("counts fragments written but not yet committed, before push", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			fragment("first change"),
		);
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-b.md"),
			fragment("second change"),
		);
		const result = checkChangelogFragments({
			base: "HEAD",
			cwd: dir,
			rootDir: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	it("runs the default git seam against the repository at cwd", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			fragment("first change"),
		);
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-b.md"),
			fragment("second change"),
		);
		// No `git` injected: this is the production default seam, which the
		// `--base` CLI path uses and the tests otherwise never touch.
		const result = checkChangelogFragments({
			base: "HEAD",
			cwd: dir,
			rootDir: dir,
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	it("spawns the CLI in a fixture repo and fails closed on its real output", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "first change");
		addFragment(dir, "pr-b.md", "second change");
		fs.mkdirSync(path.join(dir, ".changelog", "nested"));
		fs.writeFileSync(
			path.join(dir, ".changelog", "nested", "ignored.md"),
			fragment("not a fragment"),
		);
		fs.writeFileSync(path.join(dir, ".changelog", "ignored.txt"), "ignored\n");
		const cli = path.resolve(
			process.cwd(),
			"scripts/check-changelog-fragments.mjs",
		);
		const result = spawnSync(
			process.execPath,
			[cli, "--base", "HEAD", "--cwd", dir],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"PR diff adds 2 changelog fragments; keep exactly one per PR: .changelog/pr-a.md, .changelog/pr-b.md",
		);
		expect(result.stderr).not.toContain("README.md");
		expect(result.stderr).not.toContain("ignored");

		const badBase = spawnSync(
			process.execPath,
			[cli, "--base", "deadbeef", "--cwd", dir],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(badBase.status).toBe(1);
		expect(badBase.stderr.trim().split(/\r?\n/)).toEqual([
			"unable to resolve changelog comparison base: deadbeef",
		]);

		const trailingBase = spawnSync(
			process.execPath,
			[cli, "--base", "--cwd", dir],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(trailingBase.status).toBe(1);
		expect(trailingBase.stderr.trim().split(/\r?\n/)).toEqual([
			"usage: node scripts/check-changelog-fragments.mjs [--base <ref>] [--cwd <dir>]",
		]);
	});

	it("returns null when no base ref is available", () => {
		const dir = makeRepo();
		expect(addedChangelogFragments({ git: gitFor(dir), cwd: dir })).toBe(null);
	});
});
