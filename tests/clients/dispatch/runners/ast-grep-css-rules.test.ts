/**
 * CSS-language ast-grep rules through the napi in-process fallback (#2199).
 *
 * These tests use a real runner invocation. They verify both that CSS rules
 * run on CSS roots and that they do not run on HTML roots.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import {
	firedRuleIds,
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

describe("ast-grep CSS rules (integration via napi fallback)", () => {
	it("fires no-important on a real !important declaration", async () => {
		const { ctx } = env.addFile(
			"sample.css",
			[".modal {", "  z-index: 9999 !important;", "}", ""].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).toContain("no-important");
	});

	it("does not fire on plain CSS without !important", async () => {
		const { ctx } = env.addFile(
			"plain.css",
			[".button {", "  color: red;", "}", ""].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).not.toContain("no-important");
	});

	it("does not run a CSS rule on an HTML root", async () => {
		const { ctx } = env.addFile(
			"sample.html",
			[
				"<!doctype html>",
				"<style>.modal { z-index: 9999 !important; }</style>",
				"<p>!important in HTML text</p>",
				"",
			].join("\n"),
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(firedRuleIds(result)).not.toContain("no-important");
	});
});
