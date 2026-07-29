/**
 * #448 — the runner's dispatch filters through the REAL engine: blockingOnly's
 * review-tier drop and the modifiedRanges gate. The mocked twin
 * (tree-sitter-runner.test.ts) stubs the query loader empty, so none of this
 * is reachable there. Fixture rules: debugger-statement (severity error,
 * inline_tier blocking) and variable-shadowing (inline_tier review).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";

// Keep unrelated fire-and-forget review-graph enrichment out of real-runner tests.
vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: () => ({ added: [], removed: [], modified: [] }),
	}),
);
import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";
let env: RealRunnerEnv;
afterAll(() => env.cleanup());

// Matches variable-shadowing and puts debugger statements on lines 3 and 8.
const MIXED_SRC = [
	"function process(data) {",
	"\tconst data = 1;",
	"\tdebugger;",
	"\treturn data;",
	"}",
	"",
	"function other() {",
	"\tdebugger;",
	"}",
	"",
].join("\n");

describe("tree-sitter runner — dispatch filtering (#448)", () => {
	beforeAll(async () => {
		env = makeRealRunnerEnv();
		await assertGrammarAvailable("typescript");
	});

	// The positive review-tier assertion keeps both negative filters below from
	// passing vacuously if the real query fails to compile.
	it("runs review-tier rules and ignores modifiedRanges outside blockingOnly", async () => {
		const { ctx } = env.addFile("all-diagnostics.ts", MIXED_SRC, {
			modifiedRanges: [{ start: 1, end: 4 }],
		});
		const result = await treeSitterRunner.run(ctx);
		const fired = firedRuleIds(result);
		const debuggerLines = result.diagnostics
			.filter((d) => d.rule === "debugger-statement")
			.map((d) => d.line);
		expect(fired).toContain("variable-shadowing");
		expect(debuggerLines).toEqual([3, 8]);
	}, 30_000);

	it("filters review-tier rules and gates blocking diagnostics to modifiedRanges", async () => {
		const { ctx } = env.addFile("blocking-only.ts", MIXED_SRC, {
			blockingOnly: true,
			modifiedRanges: [{ start: 1, end: 4 }],
		});
		const result = await treeSitterRunner.run(ctx);
		const fired = firedRuleIds(result);
		const debuggerLines = result.diagnostics
			.filter((d) => d.rule === "debugger-statement")
			.map((d) => d.line);
		expect(fired).not.toContain("variable-shadowing");
		expect(debuggerLines).toEqual([3]);
	}, 30_000);
});
