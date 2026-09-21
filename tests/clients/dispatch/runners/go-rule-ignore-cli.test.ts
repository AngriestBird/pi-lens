// #3240: Go's rule is delivered by the real ast-grep CLI, not the in-process
// napi runner. Keep the nested directory carve-outs on that production path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAstGrepNativeExe } from "../../../../clients/lsp/wait-policy/strategies.js";
import { resolveBaselineSgconfig } from "../../../../clients/sgconfig.js";
import { safeSpawnAsync } from "../../../../clients/safe-spawn.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

const astGrepExe = resolveAstGrepNativeExe();
const suite = astGrepExe ? describe : describe.skip;
const goSource = [
	"package example",
	"",
	'import "fmt"',
	"",
	'func Run() { fmt.Println("output") }',
	"",
].join("\n");

suite("go-no-fmt-println nested ignore directories (#3240)", () => {
	let tmpDir: string;
	let cleanup: () => void;

	beforeAll(() => {
		const env = setupTestEnvironment("pi-lens-go-rule-ignores-");
		tmpDir = env.tmpDir;
		cleanup = env.cleanup;
		createTempFile(
			tmpDir,
			"packages/alpha/tests/fixtures/example.go",
			goSource,
		);
		createTempFile(tmpDir, "packages/beta/cases/example.go", goSource);
		createTempFile(tmpDir, "packages/gamma/test-fixtures/example.go", goSource);
	});
	afterAll(() => cleanup?.());

	it("ignores nested fixtures/cases but keeps similarly named application code", async () => {
		const configPath = resolveBaselineSgconfig(tmpDir);
		if (!configPath) throw new Error("no ast-grep rule sources found");
		const result = await safeSpawnAsync(
			astGrepExe as string,
			["scan", "--config", configPath, "--json", tmpDir],
			{ timeout: 60_000, cwd: tmpDir },
		);
		if (result.error) throw result.error;
		const findings = JSON.parse(result.stdout || "[]") as Array<{
			file: string;
			ruleId: string;
		}>;
		const normalized = findings.map((finding) => ({
			...finding,
			file: finding.file.split("\\").join("/"),
		}));
		const forRule = (suffix: string) =>
			normalized.filter(
				(finding) =>
					finding.ruleId === "go-no-fmt-println" &&
					finding.file.endsWith(suffix),
			);

		expect(forRule("packages/alpha/tests/fixtures/example.go")).toEqual([]);
		expect(forRule("packages/beta/cases/example.go")).toEqual([]);
		expect(forRule("packages/gamma/test-fixtures/example.go")).toHaveLength(1);
	}, 60_000);
});
