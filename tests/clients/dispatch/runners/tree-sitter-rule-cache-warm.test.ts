/**
 * #448 — rule-cache round-trip. Every other real-runner test uses a fresh temp
 * cwd, so it only ever sees a COLD cache; fields the cache.set projection drops
 * (rule-cache.ts QueryCacheEntry) silently vanish on the warm path in
 * production. Each test here runs the runner twice against the SAME cwd so run
 * 2 rehydrates from the cache written by run 1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";

const { logTreeSitter } = vi.hoisted(() => ({ logTreeSitter: vi.fn() }));
vi.mock("../../../../clients/tree-sitter-logger.js", () => ({
	logTreeSitter: (entry: unknown) => logTreeSitter(entry),
}));
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
afterAll(() => env?.cleanup());

const ASSERT_SRC = "def f(x):\n    assert x > 0, 'x required'\n    return x\n";

// [false, true] holds because each `it` below is single-language (python-only,
// then typescript-only) — RuleCache is per-language, and its on-disk cache
// under PI_LENS_HOME/projects/<slug> survives `env.cleanup()` (which only
// removes the fixture cwd, not PI_LENS_HOME).
function observedCacheHits(): Array<boolean | undefined> {
	return logTreeSitter.mock.calls
		.map(([entry]) => entry as { phase?: string; cacheHit?: boolean })
		.filter((entry) => entry.phase === "queries_loaded")
		.map((entry) => entry.cacheHit);
}

describe("tree-sitter runner — rule cache round-trip (#448)", () => {
	beforeAll(async () => {
		env = makeRealRunnerEnv();
		await assertGrammarAvailable("python");
		await assertGrammarAvailable("typescript");
	});

	it("skip_test_files survives a cache round-trip", async () => {
		logTreeSitter.mockClear();
		// Cold run populates <data-dir>/cache/python-rules-v*.json.
		const cold = env.addFile("app.py", ASSERT_SRC);
		expect(firedRuleIds(await treeSitterRunner.run(cold.ctx))).toContain(
			"python-assert-production",
		);

		// Warm run rehydrates from the cache; the #440 carve-out must survive.
		const warm = env.addFile(
			"tests/test_app.py",
			"def test_ok():\n    assert 1 + 1 == 2\n",
		);
		expect(firedRuleIds(await treeSitterRunner.run(warm.ctx))).not.toContain(
			"python-assert-production",
		);
		expect(observedCacheHits()).toEqual([false, true]);
	}, 30_000);

	it("fix_action survives a cache round-trip", async () => {
		logTreeSitter.mockClear();
		// has_fix IS cached, so asserting on `fixable` would prove nothing; the
		// fix_action-derived suggestion is what the warm path loses.
		const suggestionFor = async (relPath: string) => {
			const { ctx } = env.addFile(relPath, "debugger;\n");
			const result = await treeSitterRunner.run(ctx);
			const d = result.diagnostics.find((x) => x.rule === "debugger-statement");
			expect(d).toBeDefined();
			return d?.fixSuggestion;
		};

		expect(await suggestionFor("a.ts")).toBe("remove this statement");
		expect(await suggestionFor("b.ts")).toBe("remove this statement");
		expect(observedCacheHits()).toEqual([false, true]);
	}, 30_000);
});
