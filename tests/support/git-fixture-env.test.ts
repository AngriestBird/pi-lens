import { describe, expect, it } from "vitest";
import { gitExecFileSync, gitFixtureEnv } from "./git-fixture-env.js";
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
});
