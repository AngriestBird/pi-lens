/**
 * #1775: `sessionstart.log` recorded no build identity. `getBuildIdentity`
 * fills that gap with the serving checkout's commit, dirty flag, entry-file
 * mtime, and package version — derived from the RUNNING build's own files
 * (`getPackageRoot`), never from `process.cwd()`.
 *
 * Spawns a REAL child Node process against a real fixture git repo, mirroring
 * metrics-history-stderr.test.ts's approach: `getCurrentCommit`'s git-fixture
 * conventions (env scrubbed via gitFixtureEnv, no `GIT_DIR`-family leakage,
 * a fixture-only `user.name`) are reused rather than re-derived by hand.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecFileSync, gitFixtureEnv, hasGit } from "../support/git-fixture-env.js";

const BUILD_IDENTITY_JS = path.resolve(
	__dirname,
	"../../clients/build-identity.js",
);

function writeFixturePackage(dir: string, version: string): void {
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture", version }),
	);
}

/** Runs `getBuildIdentity(entryUrl)` in a fresh child process and returns the
 *  parsed JSON result printed to stdout. */
function runGetBuildIdentity(
	cwd: string,
	entryFile: string,
	env: NodeJS.ProcessEnv,
): Record<string, unknown> {
	const entryUrl = pathToFileURL(entryFile).href;
	const script = [
		`const { getBuildIdentity } = require(${JSON.stringify(BUILD_IDENTITY_JS)});`,
		`process.stdout.write(JSON.stringify(getBuildIdentity(${JSON.stringify(entryUrl)})));`,
	].join("\n");
	const result = spawnSync(process.execPath, ["-e", script], {
		cwd,
		encoding: "utf-8",
		env,
	});
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout);
}

describe("getBuildIdentity (#1775)", () => {
	it.skipIf(!hasGit())(
		"records the real commit, a clean dirty flag, and the package version",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-build-identity-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const runGit = (args: string[]) =>
				gitExecFileSync("git", args, {
					cwd: tmp,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				runGit(["init", "-q"]);
				runGit(["config", "user.email", "fixture@example.com"]);
				runGit(["config", "user.name", "pi-lens fixture"]);
				writeFixturePackage(tmp, "9.9.9");
				const entryFile = path.join(tmp, "entry.js");
				fs.writeFileSync(entryFile, "// fixture entry\n");
				runGit(["add", "package.json", "entry.js"]);
				runGit(["commit", "-qm", "fixture"]);
				const expectedCommit = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{ cwd: tmp, encoding: "utf-8", env: fixtureEnv },
				).trim();

				const identity = runGetBuildIdentity(tmp, entryFile, fixtureEnv);

				expect(identity.commit).toBe(expectedCommit);
				expect(identity.dirty).toBe(false);
				expect(identity.version).toBe("9.9.9");
				expect(typeof identity.entryMtime).toBe("string");
				expect(new Date(identity.entryMtime as string).toString()).not.toBe(
					"Invalid Date",
				);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!hasGit())(
		"reports dirty=true when the working tree has an uncommitted change",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-build-identity-dirty-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const runGit = (args: string[]) =>
				gitExecFileSync("git", args, {
					cwd: tmp,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				runGit(["init", "-q"]);
				runGit(["config", "user.email", "fixture@example.com"]);
				runGit(["config", "user.name", "pi-lens fixture"]);
				writeFixturePackage(tmp, "1.0.0");
				const entryFile = path.join(tmp, "entry.js");
				fs.writeFileSync(entryFile, "// fixture entry\n");
				runGit(["add", "package.json", "entry.js"]);
				runGit(["commit", "-qm", "fixture"]);
				// Uncommitted change — the working tree is now dirty.
				fs.writeFileSync(entryFile, "// fixture entry, edited\n");

				const identity = runGetBuildIdentity(tmp, entryFile, fixtureEnv);

				expect(identity.dirty).toBe(true);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it("falls back to \"unknown\" commit and the package version outside a git repo", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-build-identity-nogit-"),
		);
		try {
			writeFixturePackage(tmp, "2.3.4");
			const entryFile = path.join(tmp, "entry.js");
			fs.writeFileSync(entryFile, "// fixture entry\n");

			const identity = runGetBuildIdentity(tmp, entryFile, {
				...process.env,
			});

			expect(identity.commit).toBe("unknown");
			expect(identity.dirty).toBeUndefined();
			expect(identity.version).toBe("2.3.4");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
