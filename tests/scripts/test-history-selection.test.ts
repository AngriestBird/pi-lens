import { describe, expect, it } from "vitest";
import { selectTargetedTests } from "../../scripts/pre-push-targeted-tests.mjs";
import {
	HISTORY_MAX_SELECTED,
	HISTORY_STALE_MS,
	selectFromHistory,
} from "../../scripts/lib/test-history-selection.mjs";

/**
 * #3215 lane 3. The pre-push selector reads imports only, so a change to a
 * non-imported file (the rule YAML, a doc) selects nothing even when past heads
 * that touched the same directory failed specific tests. #3214 round 1 redded
 * only `tests/scripts/rule-catalogs.test.ts`, reachable from no import of the
 * changed YAML. `selectFromHistory` adds those tests from the rollup's
 * `failures` view; it never removes the import-derived selection.
 */

const now = Date.parse("2026-10-07T12:00:00.000Z");
const fresh = new Date(now - HISTORY_STALE_MS / 2).toISOString();
const head = (n: number) => String(n).padStart(40, "0");
const allTests = [
	"tests/scripts/rule-catalogs.test.ts",
	"tests/config/sweep-floor-coverage.test.ts",
	"tests/clients/other.test.ts",
	"tests/clients/ci-only.test.ts",
];

function summary(
	failures: Array<{ file: string; headSha: string; flake?: boolean }>,
	generatedAt = fresh,
) {
	return {
		generatedAt,
		failures: failures.map((f) => ({ flake: false, ...f })),
	};
}

function touching(map: Record<string, string[]>) {
	const asked: string[][] = [];
	const pathsForHeads = (heads: string[]) => {
		asked.push([...heads]);
		return new Map(
			heads.filter((h) => map[h]).map((h) => [h, map[h] as string[]]),
		);
	};
	return { pathsForHeads, asked };
}

const yamlChange = ["rules/ast-grep-rules/rules/no-new-rule.yml"];
const roundOne = summary([
	{ file: "tests/scripts/rule-catalogs.test.ts", headSha: head(1) },
	{ file: "tests/config/sweep-floor-coverage.test.ts", headSha: head(1) },
]);
const roundOneTouched = {
	[head(1)]: ["rules/ast-grep-rules/rules/other-rule.yml", "docs/a.md"],
};

describe("selectFromHistory (#3215 lane 3)", () => {
	it("selects what failed on past heads that touched the changed directory, where import selection finds nothing", () => {
		// Recurrence: #3214 round 1 (rules/ YAML change, red only in
		// rule-catalogs.test.ts), invisible to the import-only pre-push selector.
		const importOnly = selectTargetedTests(yamlChange, allTests);
		expect(importOnly.selected).toEqual([]);
		const history = selectFromHistory({
			summary: roundOne,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(history.status).toBe("selected");
		expect([...history.picks].sort()).toEqual([
			"tests/config/sweep-floor-coverage.test.ts",
			"tests/scripts/rule-catalogs.test.ts",
		]);
		const merged = selectTargetedTests(yamlChange, allTests, {
			historyPicks: history.picks,
		});
		expect([...merged.selected].sort()).toEqual([...history.picks].sort());
		expect(merged.fromHistory).toEqual(expect.arrayContaining(history.picks));
	});

	it("ignores a failure that passed on the same head (a flake, not a signal)", () => {
		// Recurrence: a flaky file's co-occurrence would put it in every
		// selection for the directory its flaky heads touched.
		const flaky = summary([
			{
				file: "tests/scripts/rule-catalogs.test.ts",
				headSha: head(1),
				flake: true,
			},
		]);
		const result = selectFromHistory({
			summary: flaky,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(result.status).toBe("none");
	});

	it.each([
		[
			"a sibling directory under the same top-level directory",
			"rules/ast-grep-rules/readme.md",
		],
		["another top-level directory", "clients/lsp/client.ts"],
	])("does not select for a change in %s", (_name, changedFile) => {
		// Recurrence: prefix matching widened to a shared top-level segment would
		// put every recorded failure under `rules/` in every `rules/**` selection.
		const result = selectFromHistory({
			summary: roundOne,
			changed: [changedFile],
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
	});

	it("falls back to import-only and says so when the history is stale", () => {
		// The issue's own caveat: lagging data degrades selection. The nightly
		// rollup was red from 2026-09-30, so the journal on the data branch is
		// the stale case today.
		const stale = new Date(now - HISTORY_STALE_MS - 1000).toISOString();
		const asked = touching(roundOneTouched);
		const result = selectFromHistory({
			summary: { ...roundOne, generatedAt: stale },
			changed: yamlChange,
			allTests,
			pathsForHeads: asked.pathsForHeads,
			now,
		});
		expect(result.status).toBe("stale");
		expect(result.picks).toEqual([]);
		expect(result.detail).toContain("stale");
		expect(asked.asked).toEqual([]);
	});

	it.each([
		["no summary", null],
		["a pre-lane-3 summary without a failures view", { rowCount: 3 }],
		["a fresh summary without a failures view", { generatedAt: fresh }],
		["a summary with no generation time", { failures: [] }],
		["an unparseable generation time", { failures: [], generatedAt: "soon" }],
	])("is unavailable, never stale-guessed, for %s", (_name, value) => {
		const result = selectFromHistory({
			summary: value as never,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching({}).pathsForHeads,
			now,
		});
		expect(result.status).toBe("unavailable");
		expect(result.picks).toEqual([]);
	});

	it("skips heads git cannot resolve to paths, and counts them", () => {
		// Recurrence: an unmerged PR head absent from the clone, or a merge-commit
		// head (no first-parent diff to attribute), must not crash or match.
		const result = selectFromHistory({
			summary: roundOne,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching({}).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(result.detail).toContain("1 of 1 failing head(s) unresolved");
	});

	it("drops a recorded failure whose test file no longer exists", () => {
		const gone = summary([
			{ file: "tests/deleted/long-gone.test.ts", headSha: head(1) },
		]);
		const result = selectFromHistory({
			summary: gone,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
	});

	it("does not consult history for a changed test file", () => {
		// Recurrence: a tests/ directory change would match every past head that
		// touched tests/ and select its flaky failures; the changed test itself
		// is already selected directly.
		const asked = touching({ [head(1)]: ["tests/scripts/x.test.ts"] });
		const result = selectFromHistory({
			summary: roundOne,
			changed: ["tests/scripts/x.test.ts"],
			allTests,
			pathsForHeads: asked.pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(asked.asked).toEqual([]);
	});

	it("ranks by distinct failing heads and caps the addition", () => {
		const many = Array.from({ length: HISTORY_MAX_SELECTED + 3 }, (_, i) => ({
			file: `tests/many/t${String(i).padStart(2, "0")}.test.ts`,
			headSha: head(10 + i),
		}));
		// t05 fails on two heads, so it ranks first.
		many.push({ file: "tests/many/t05.test.ts", headSha: head(99) });
		const tests = [
			...allTests,
			...many.map((f) => f.file).filter((f, i, a) => a.indexOf(f) === i),
		];
		const touched = Object.fromEntries(
			many.map((f) => [f.headSha, ["rules/ast-grep-rules/rules/z.yml"]]),
		);
		const result = selectFromHistory({
			summary: summary(many),
			changed: yamlChange,
			allTests: tests,
			pathsForHeads: touching(touched).pathsForHeads,
			now,
		});
		expect(result.picks).toHaveLength(HISTORY_MAX_SELECTED);
		expect(result.picks[0]).toBe("tests/many/t05.test.ts");
	});
});

describe("selectTargetedTests with history picks (#3215 lane 3)", () => {
	it("adds history picks beside the import selection", () => {
		// Recurrence: lane 3 must add, never remove (the issue's own rule); the
		// import cap degrades to the registries, and history picks are bounded by
		// their own cap so they survive it.
		const result = selectTargetedTests(["clients/hub.ts"], allTests, {
			historyPicks: ["tests/scripts/rule-catalogs.test.ts"],
		});
		expect(result.selected).toContain("tests/scripts/rule-catalogs.test.ts");
		expect(result.fromHistory).toEqual(["tests/scripts/rule-catalogs.test.ts"]);
	});

	it("does not report an import-selected test as added by history", () => {
		// A changed test file is selected directly (it must exist on disk).
		const self = "tests/scripts/test-history-selection.test.ts";
		const result = selectTargetedTests([self], [...allTests, self], {
			historyPicks: [self],
		});
		expect(result.selected).toContain(self);
		expect(result.fromHistory).toEqual([]);
	});
});
