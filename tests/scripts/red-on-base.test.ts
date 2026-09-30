import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decideVerdict } from "../../scripts/red-on-base.mjs";

const CLI = resolve("scripts/red-on-base.mjs");

describe("red-on-base verdict", () => {
	it("classifies a red head and green base as caused by the change", () => {
		expect(
			decideVerdict({
				head: { passed: false, names: ["changed test"] },
				base: { passed: true, names: [] },
				isolation: { passed: false, names: ["changed test"] },
			}),
		).toEqual({ verdict: "CAUSED-BY-CHANGE", failingNames: ["changed test"] });
	});

	it("classifies a red head and red base as red on base", () => {
		expect(
			decideVerdict({
				head: { passed: false, names: ["base test"] },
				base: { passed: false, names: ["base test"] },
				isolation: { passed: false, names: ["base test"] },
			}).verdict,
		).toBe("RED-ON-BASE");
	});

	it("classifies a green isolated head as isolation green", () => {
		expect(
			decideVerdict({
				head: { passed: false, names: ["interference"] },
				base: { passed: false, names: ["interference"] },
				isolation: { passed: true, names: [] },
			}).verdict,
		).toBe("ISOLATION-GREEN");
	});
});

describe("red-on-base CLI", () => {
	it("uses the injected test command and unlinks node_modules before removal", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-red-on-base-test-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		try {
			const realGit = "/usr/bin/git";
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ scripts: { build: 'node -e \\"\\"' } }),
			);
			writeFileSync(join(root, "version.txt"), "base\n");
			writeFileSync(
				join(root, "fake-test.mjs"),
				[
					"import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
					"import { join } from 'node:path';",
					"const dir = process.env.PI_LENS_HOME; mkdirSync(dir, { recursive: true });",
					"const countFile = join(dir, 'count'); const count = Number(existsSync(countFile) ? readFileSync(countFile, 'utf8') : 0) + 1; writeFileSync(countFile, String(count));",
					"if (readFileSync(join(process.cwd(), 'version.txt'), 'utf8').trim() === 'base') process.exit(0);",
					"if (count === 1) { console.error('failing test: changed test'); process.exit(1); }",
				].join("\n"),
			);
			writeFileSync(
				join(bin, "git"),
				[
					"#!/bin/sh",
					`real=${realGit}`,
					"if [ \"$1 $2 $3\" = 'worktree remove --force' ]; then",
					"  test ! -e \"$4/node_modules\" || { echo 'node_modules still present at remove' >&2; exit 91; }",
					'  echo unlink-before-remove > "$CLEANUP_LOG"',
					"fi",
					'exec "$real" "$@"',
				].join("\n"),
			);
			const git = join(bin, "git");
			const chmod = 0o755;
			chmodSync(git, chmod);
			execFileSync(realGit, ["init", "-q"], { cwd: root });
			execFileSync(realGit, ["config", "user.email", "test@example.com"], {
				cwd: root,
			});
			execFileSync(realGit, ["config", "user.name", "Test"], { cwd: root });
			execFileSync(realGit, ["add", "."], { cwd: root });
			execFileSync(realGit, ["commit", "-qm", "base"], { cwd: root });
			writeFileSync(join(root, "version.txt"), "head\n");
			execFileSync(realGit, ["add", "version.txt"], { cwd: root });
			execFileSync(realGit, ["commit", "-qm", "head"], { cwd: root });
			mkdirSync(join(root, "node_modules"));
			const output = execFileSync(
				process.execPath,
				[
					CLI,
					"version.txt",
					"--base",
					"HEAD~1",
					"--test-command",
					join(root, "fake-test.mjs"),
				],
				{
					cwd: root,
					env: {
						...process.env,
						PATH: `${bin}${delimiter}${process.env.PATH}`,
						CLEANUP_LOG: join(root, "cleanup-proof"),
						PI_LENS_TEST_MAX_WORKERS: "6",
					},
					encoding: "utf8",
				},
			);
			expect(output).toContain("ISOLATION-GREEN");
			expect(readFileSync(join(root, "cleanup-proof"), "utf8")).toContain(
				"unlink-before-remove",
			);
			expect(lstatSync(join(root, "node_modules")).isDirectory()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
