/**
 * #440 — per-rule `skip_test_files` carve-out. `python-assert-production` flags
 * `assert` (stripped by python -O), but `assert` is the idiomatic test assertion,
 * so firing in test files is pure noise. The tree-sitter runner otherwise runs on
 * test files, so the rule opts out via `skip_test_files`. Exercised through the
 * REAL runner (real client + real query loader) so the isTestFile filter is under
 * test, not mocked away.
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

async function rulesFor(relPath: string, content: string): Promise<Set<string>> {
	const real = makeRealRunnerCtx(relPath, content);
	cleanups.push(real.cleanup);
	return firedRuleIds(await treeSitterRunner.run(real.ctx));
}

const ASSERT_SRC = "def f(x):\n    assert x > 0, 'x required'\n    return x\n";

describe("tree-sitter runner — skip_test_files (#440)", () => {
	beforeAll(() => assertGrammarAvailable("python"));

	it("flags python-assert-production in a production file", async () => {
		expect(await rulesFor("app.py", ASSERT_SRC)).toContain(
			"python-assert-production",
		);
	}, 30_000);

	it("does NOT flag python-assert-production in a tests/ file", async () => {
		expect(
			await rulesFor(
				"tests/test_app.py",
				"def test_ok():\n    assert 1 + 1 == 2\n",
			),
		).not.toContain("python-assert-production");
	}, 30_000);
});
