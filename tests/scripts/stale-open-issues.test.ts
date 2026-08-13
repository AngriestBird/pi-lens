import { describe, expect, it } from "vitest";
import { detectStaleOpenIssues, formatSummary, MAX_COMMIT_DETAILS, MAX_PAGES, PAGE_SIZE } from "../../scripts/lib/stale-open-issues.mjs";

function fakeGithub(data: Record<string, unknown>) {
	const calls: string[] = [];
	const fetcher = async (url: string) => {
		calls.push(url);
		const key = url.replace("https://api.github.com", "").split("?")[0];
		return { ok: true, status: 200, json: async () => data[key] ?? [] };
	};
	return { fetcher, calls };
}

describe("stale open-issue detector (#1323)", () => {
	it("flags open issues from closing-shaped commits and issue-named regression tests", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [{ number: 10, title: "still open", html_url: "https://github.com/acme/repo/issues/10" }, { number: 11, title: "already a PR", pull_request: {}, html_url: "https://github.com/acme/repo/issues/11" }],
			"/repos/acme/repo/commits": [{ sha: "abcdef123", commit: { message: "fix: finished it (closes #10)" } }],
			"/repos/acme/repo/commits/abcdef123": { files: [{ filename: "tests/regression-10.test.ts" }] },
		});
		const result = await detectStaleOpenIssues({ fetcher, repository: "acme/repo" });
		expect(result).toEqual([{ issue: expect.objectContaining({ number: 10 }), evidence: ["closing-shaped commit abcdef1", "regression-test file tests/regression-10.test.ts"] }]);
	});

	it("ignores issues absent from the open-issue response and non-test filenames", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [{ number: 10, title: "open" }, { number: 12, title: "pull request", pull_request: {} }],
			"/repos/acme/repo/commits": [{ sha: "abc", commit: { message: "docs: mention fixes #12" } }],
			"/repos/acme/repo/commits/abc": { files: [{ filename: "src/12.ts" }] },
		});
		expect(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" })).toEqual([]);
	});

	it("keeps API work bounded and formats one detection-only summary", async () => {
		const { fetcher, calls } = fakeGithub({ "/repos/acme/repo/issues": [], "/repos/acme/repo/commits": [] });
		expect(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" })).toEqual([]);
		expect(MAX_PAGES).toBe(3);
		expect(PAGE_SIZE).toBe(100);
		expect(MAX_COMMIT_DETAILS).toBe(100);
		expect(calls[0]).toContain("per_page=100");
		expect(formatSummary([], { runUrl: "https://example/run" })).toContain("never closes issues");
	});
});
