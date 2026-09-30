import { describe, expect, it } from "vitest";
import {
	classifyFiles,
	classifyIssue,
	formatPlan,
	isBot,
	planContributions,
} from "../../scripts/update-contributors.mjs";

// Recorded `gh pr list` / `gh issue list` / `gh pr view --json files` shapes
// (refs #3772). Recurrence guarded: the hand-run refresh in PR #3773 that
// omitted reporters and docs/tests-only authors and could not be re-run.
const prs = [
	{ number: 3702, author: { login: "LucaBarrella" } },
	{ number: 3369, author: { login: "AngriestBird" } },
	{ number: 3638, author: { login: "app/dependabot" } },
	{ number: 1, author: { login: "apmantza" } },
];
const issues = [
	{
		number: 3693,
		title: "Support X",
		author: { login: "LucaBarrella" },
		labels: [{ name: "enhancement" }],
	},
	{
		number: 3749,
		title: "MCP tools accept unknown arguments silently",
		author: { login: "zjael" },
		labels: [],
	},
	{
		number: 3442,
		title: "nightly drift",
		author: { login: "app/github-actions" },
		labels: [{ name: "nightly-drift" }],
	},
	{ number: 9, title: "Some question", author: { login: "asker" }, labels: [] },
];
const filesByPr = {
	3702: ["clients/a.ts", "tests/a.test.ts"],
	3369: ["AGENTS.md", "tests/b.test.ts"],
};

describe("update-contributors planning", () => {
	it("credits code, reporters, and docs/tests-only PRs; skips owner and bots", () => {
		const plan = planContributions({
			prs,
			issues,
			filesByPr,
			existing: {},
			owner: "apmantza",
		});
		const by = Object.fromEntries(plan.map((p) => [p.login, p]));
		expect(by.LucaBarrella.add).toEqual(["code", "ideas"]);
		expect(by.LucaBarrella.evidence).toEqual({ code: [3702], ideas: [3693] });
		expect(by.AngriestBird.add).toEqual(["doc", "test"]);
		expect(by.zjael.add).toEqual(["bug"]);
		expect(Object.keys(by).sort()).toEqual([
			"AngriestBird",
			"LucaBarrella",
			"zjael",
		]);
	});

	it("is idempotent: a second run over the applied result plans nothing", () => {
		const first = planContributions({
			prs,
			issues,
			filesByPr,
			existing: {},
			owner: "apmantza",
		});
		const existing = Object.fromEntries(first.map((p) => [p.login, p.add]));
		const second = planContributions({
			prs,
			issues,
			filesByPr,
			existing,
			owner: "apmantza",
		});
		expect(second).toEqual([]);
		expect(formatPlan(second)).toContain("up to date");
	});

	it("only adds missing types to an existing entry, case-insensitively", () => {
		const plan = planContributions({
			prs,
			issues,
			filesByPr,
			existing: { lucabarrella: ["code"] },
			owner: "apmantza",
		});
		const luca = plan.find((p) => p.login === "LucaBarrella");
		expect(luca).toMatchObject({ isNew: false, add: ["ideas"] });
	});
});

describe("update-contributors classification", () => {
	it("maps changed files to code, doc, test", () => {
		expect(classifyFiles(["docs/x.md"])).toEqual(["doc"]);
		expect(classifyFiles(["tests/x.test.ts"])).toEqual(["test"]);
		expect(classifyFiles(["README.md", "tests/x.test.ts"])).toEqual([
			"doc",
			"test",
		]);
		expect(classifyFiles(["README.md", "clients/x.ts"])).toEqual(["code"]);
	});

	it("labels win, then titles; drift and duplicates earn nothing", () => {
		expect(classifyIssue({ title: "x", labels: [{ name: "bug" }] })).toBe(
			"bug",
		);
		expect(classifyIssue({ title: "Bug: thing", labels: [] })).toBe("bug");
		expect(classifyIssue({ title: "Add Expert LSP", labels: [] })).toBe(
			"ideas",
		);
		expect(
			classifyIssue({
				title: "crash on start",
				labels: [{ name: "duplicate" }],
			}),
		).toBeNull();
		expect(classifyIssue({ title: "hello", labels: [] })).toBeNull();
	});

	it("recognises bot logins", () => {
		expect(isBot("app/dependabot")).toBe(true);
		expect(isBot("renovate[bot]")).toBe(true);
		expect(isBot("LucaBarrella")).toBe(false);
	});
});
