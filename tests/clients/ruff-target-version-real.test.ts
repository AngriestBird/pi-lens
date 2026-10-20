// flake-shape: real-process-spawn — the production autofix path runs the real
// ruff binary; a double cannot model ruff's own config discovery and rule set.
/**
 * #4638 ticket 02, behavioural half. The argv case pins what the client asks
 * ruff to do; this one pins what ruff DOES with it, through
 * `RuffClient.fixFileAsync` and the real binary.
 *
 * `--target-version` does not gate ruff's parser (0.16.8 parses PEP 695 at
 * `py310` all the same), so the divergence is a rule FIX gated by the level:
 * `UP006` is safe-fixable at >= py39 and inert at py38. The old pre-check ran
 * at `py310` while the `--fix` pass ran at the project's `py38`, so the caller
 * was told `fixed: 1` for a file ruff never touched. Both directions are pinned:
 * the report matches the file when the declaration forbids the fix, and the fix
 * still lands when the declaration allows it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuffClient } from "../../clients/ruff-client.js";
import { removeTempDirSync } from "../clients/test-utils.js";

// lane: the real-bytes tool tree supplies ruff (`captured-real-output` lane in
// CI); a runner without it skips the case visibly instead of mocking the binary.
const hasRuff = (() => {
	try {
		return spawnSync("ruff", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
})();

const SOURCE = "from typing import List\n\nx: List[int] = []\n";

let cwd: string;

function setUpProject(targetVersion: string): { filePath: string } {
	fs.writeFileSync(
		path.join(cwd, "pyproject.toml"),
		[
			'[project]\nname = "demo"',
			`requires-python = ">=${targetVersion}"`,
			`[tool.ruff]\ntarget-version = "py${targetVersion.replace(".", "")}"`,
			'[tool.ruff.lint]\nselect = ["UP006"]',
			"",
		].join("\n"),
	);
	const filePath = path.join(cwd, "app.py");
	fs.writeFileSync(filePath, SOURCE);
	return { filePath };
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-ruff-real-"));
});

afterEach(() => {
	removeTempDirSync(cwd);
});

describe.skipIf(!hasRuff)(
	"ruff autofix agrees with the project's syntax level (#4638)",
	() => {
		it("reports no fix when the project's level forbids it", async () => {
			// py38: UP006 is inert, so the fix pass changes nothing. The pre-check
			// must reach the same verdict instead of measuring at the old py310.
			const { filePath } = setUpProject("3.8");

			const result = await new RuffClient().fixFileAsync(filePath, cwd);

			expect(result.fixed).toBe(0);
			expect(result.changed).toBe(false);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(SOURCE);
		});

		it("applies and reports the fix when the project's level allows it", async () => {
			const { filePath } = setUpProject("3.12");

			const result = await new RuffClient().fixFileAsync(filePath, cwd);

			expect(result.fixed).toBe(1);
			expect(result.changed).toBe(true);
			expect(fs.readFileSync(filePath, "utf-8")).not.toContain("List[int]");
		});
	},
);
