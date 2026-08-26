import { afterEach, describe, expect, it } from "vitest";
import {
	gitExecFileSync,
	gitExecSync,
	gitFixtureEnv,
	gitFixtureSpawnAsync,
} from "./git-fixture-env.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRUBBED_GIT_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
] as const;

describe("git fixture environment", () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	it("deletes inherited Git directory state and owns config policy", () => {
		const original = Object.fromEntries(
			SCRUBBED_GIT_VARIABLES.map((variable) => [
				variable,
				process.env[variable],
			]),
		);
		try {
			for (const variable of SCRUBBED_GIT_VARIABLES)
				process.env[variable] = "contaminated";
			const env = gitFixtureEnv("C:/fixture");
			for (const variable of SCRUBBED_GIT_VARIABLES)
				expect(env[variable], variable).toBeUndefined();
			expect(env.GIT_CONFIG_GLOBAL).toBe(path.join("C:/fixture", "gitconfig"));
			expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
		} finally {
			for (const variable of SCRUBBED_GIT_VARIABLES) {
				if (original[variable] === undefined) delete process.env[variable];
				else process.env[variable] = original[variable];
			}
		}
	});

	it("scrubs Git directory state from caller environment overrides", () => {
		const output = gitExecFileSync(
			process.execPath,
			["-e", "process.stdout.write(process.env.GIT_DIR ?? 'missing')"],
			{
				cwd: process.cwd(),
				env: { GIT_DIR: "escape" },
				encoding: "utf8",
			},
		);
		expect(output).toBe("missing");
	});

	it("keeps all three wrappers inside a throwaway repository", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-wrapper-"));
		scratch.push(repo);
		gitExecFileSync("git", ["init", "-q"], {
			cwd: repo,
			env: { GIT_DIR: "escape" },
		});
		gitExecFileSync("git", ["config", "user.name", "fixture"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "file.txt"), "fixture\n");

		const shellStatus = String(
			gitExecSync("git status --porcelain", {
				cwd: repo,
				encoding: "utf8",
			}),
		);
		const spawnedStatus = await gitFixtureSpawnAsync(
			repo,
			["status", "--porcelain"],
			{
				timeout: 5_000,
			},
		);

		expect(shellStatus).toContain("file.txt");
		expect(spawnedStatus.status).toBe(0);
		expect(spawnedStatus.stdout).toContain("file.txt");
		expect(
			gitExecFileSync("git", ["config", "user.name"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
		).toBe("fixture");
	});
});
