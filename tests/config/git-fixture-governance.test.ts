import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const directGitSpawn =
	/\b(?:execSync|execFileSync|spawnSync|spawn|execFile|safeSpawnAsync)\s*\(\s*["'`]git\b/g;

const GIT_FIXTURE_VERDICTS = [
	{
		file: "tests/clients/shared-checkout-guard.test.ts",
		scope: "#2007 real git binary block",
		verdict: "fixed (confirmed live offender 2026-08-26, two escapes)",
	},
] as const;

export function findGitSpawnOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	return files
		.filter(({ file, source }) => {
			directGitSpawn.lastIndex = 0;
			return (
				!file.endsWith("git-fixture-governance.test.ts") &&
				directGitSpawn.test(source) &&
				!source.includes("git-fixture-env")
			);
		})
		.map(({ file }) => file);
}

function testFiles(root: string): Array<{ file: string; source: string }> {
	const files: Array<{ file: string; source: string }> = [];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.name.endsWith(".test.ts"))
				files.push({ file, source: fs.readFileSync(file, "utf8") });
		}
	}
	walk(root);
	return files;
}

describe("real Git fixture governance", () => {
	it("routes every direct Git spawn through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			testFiles(path.resolve(__dirname, "..")),
		);
		expect(
			offenders,
			`Bare Git spawns found:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("detects a synthetic bare Git offender", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: 'execFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("records the confirmed per-file fixture verdicts", () => {
		expect(GIT_FIXTURE_VERDICTS).toContainEqual({
			file: "tests/clients/shared-checkout-guard.test.ts",
			scope: "#2007 real git binary block",
			verdict: "fixed (confirmed live offender 2026-08-26, two escapes)",
		});
	});
});
