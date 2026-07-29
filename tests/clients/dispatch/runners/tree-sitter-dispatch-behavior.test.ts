/**
 * #448 — the runner's dispatch filters through the REAL engine: blockingOnly's
 * review-tier drop and the modifiedRanges gate. The mocked twin
 * (tree-sitter-runner.test.ts) stubs the query loader empty, so none of this
 * is reachable there. Fixture rules: debugger-statement (severity error,
 * inline_tier blocking) and variable-shadowing (inline_tier review).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerCtx,
} from "../../../support/real-runner-ctx.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const c of cleanups) c();
});

// Matches variable-shadowing's query shape (param redeclared via const) and
// carries a debugger statement for the blocking tier.
const MIXED_SRC = [
	"function process(data) {",
	"\tconst data = 1;",
	"\tdebugger;",
	"\treturn data;",
	"}",
	"",
].join("\n");

// debugger; on source lines 2 and 8.
const TWO_DEBUGGERS_SRC = [
	"function a() {",
	"\tdebugger;",
	"}",
	"",
	"function b() {",
	"\tconst x = 1;",
	"\tvoid x;",
	"\tdebugger;",
	"}",
	"",
].join("\n");

async function debuggerHits(
	overrides: Parameters<typeof makeRealRunnerCtx>[2],
) {
	const real = makeRealRunnerCtx("two.ts", TWO_DEBUGGERS_SRC, overrides);
	cleanups.push(real.cleanup);
	const result = await treeSitterRunner.run(real.ctx);
	return result.diagnostics.filter((d) => d.rule === "debugger-statement");
}

describe("tree-sitter runner — dispatch filtering (#448)", () => {
	beforeAll(() => assertGrammarAvailable("typescript"));

	// Positive first: a query that fails to compile under the bundled grammar
	// returns 0 matches SILENTLY, which would make the blockingOnly negative
	// below pass vacuously.
	it("review-tier rules run when not blockingOnly", async () => {
		const real = makeRealRunnerCtx("app.ts", MIXED_SRC);
		cleanups.push(real.cleanup);
		const fired = firedRuleIds(await treeSitterRunner.run(real.ctx));
		expect(fired).toContain("variable-shadowing");
		expect(fired).toContain("debugger-statement");
	}, 30_000);

	it("blockingOnly filters review-tier rules pre-query", async () => {
		const real = makeRealRunnerCtx("app.ts", MIXED_SRC, {
			blockingOnly: true,
		});
		cleanups.push(real.cleanup);
		const fired = firedRuleIds(await treeSitterRunner.run(real.ctx));
		expect(fired).toContain("debugger-statement");
		expect(fired).not.toContain("variable-shadowing");
	}, 30_000);

	it("modifiedRanges gates blocking diagnostics to changed lines", async () => {
		const hits = await debuggerHits({
			blockingOnly: true,
			modifiedRanges: [{ start: 1, end: 3 }],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(2);
	}, 30_000);

	it("modifiedRanges do not gate when blockingOnly is false", async () => {
		const hits = await debuggerHits({
			blockingOnly: false,
			modifiedRanges: [{ start: 1, end: 3 }],
		});
		expect(hits.map((d) => d.line).sort((a, b) => a - b)).toEqual([2, 8]);
	}, 30_000);
});
