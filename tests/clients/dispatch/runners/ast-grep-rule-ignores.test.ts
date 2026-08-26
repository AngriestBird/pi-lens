// #965: no-console-except-error should not flag CLI scripts or a logger
// implementation's console fallback/sink, while still flagging accidental
// console output in ordinary application source. Exercises the real
// `ignores` glob carve-out (clients/dispatch/runners/ast-grep-napi.ts +
// clients/dispatch/runners/yaml-rule-parser.ts) end to end through the
// shipped no-console-except-error rule YAML.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import { loadYamlRules } from "../../../../clients/dispatch/runners/yaml-rule-parser.js";
import {
	linesFor,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
});
afterAll(() => env.cleanup());

describe("no-console-except-error ignores CLI scripts and logger sinks (#965)", () => {
	it("uses ignores for every VTCode Go rule and covers fixture paths (#2207)", () => {
		const rules = loadYamlRules(
			path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
		);
		const expected = new Map([
			[
				"go-no-fmt-println",
				["**/*_test.go", "**/examples/**", "tests/fixtures/**", "cases/**"],
			],
			["go-no-panic-in-lib", ["**/*_test.go", "**/cmd/**"]],
			["go-no-underscore-func-name", ["**/*_test.go"]],
			["go-prefer-errors-is", ["**/*_test.go"]],
			["go-prefer-string-builder", ["**/*_test.go"]],
		]);
		for (const [id, ignores] of expected) {
			expect(rules.find((rule) => rule.id === id)).toMatchObject({ ignores });
		}
	});

	it("still flags accidental console.log in ordinary application source", async () => {
		const { ctx } = env.addFile(
			"src/widget.ts",
			'console.log("leftover debug output");\n',
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([
			1,
		]);
	});

	it("does not flag console output inside scripts/**", async () => {
		const { ctx } = env.addFile(
			"scripts/bench-startup.ts",
			'console.log("benchmark result: 12ms");\n',
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([]);
	});

	it("does not flag console output inside a logger.ts implementation", async () => {
		const { ctx } = env.addFile(
			"lib/logger.ts",
			"export function warn(msg: string) { console.warn(msg); }\n",
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(linesFor(result.diagnostics, "no-console-except-error")).toEqual([]);
	});
});
