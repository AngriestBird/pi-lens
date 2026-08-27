import { afterEach, describe, expect, it, vi } from "vitest";
import {
	INVALID_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywords,
	parseCloseKeywords,
	verifyMergedPullRequest,
} from "../../scripts/check-close-keywords.mjs";
// Reused, not reimplemented (#2086): check-close-keywords.mjs imports this
// straight from check-pr-body.mjs. Its own edge cases (missing token,
// non-2xx, malformed body) are already covered by
// tests/scripts/check-pr-body.test.ts's "live PR body resolution (#2085)"
// suite -- no need to duplicate them here.
import { resolveLivePrBody } from "../../scripts/check-pr-body.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("close-keyword parser (#1320)", () => {
	it("parses one close keyword", () => {
		expect(parseCloseKeywords("Closes #123")).toMatchObject({
			issues: [123],
			commaLists: [],
		});
	});

	it("parses multiple correctly separated close keywords", () => {
		expect(
			parseCloseKeywords("Fixes #1. resolves #2; CLOSED #3"),
		).toMatchObject({
			issues: [1, 2, 3],
			commaLists: [],
		});
	});

	it("flags a comma-separated close list", () => {
		expect(lintCloseKeywords("Closes #123, #456")).toMatchObject({
			issues: [123],
			commaLists: [123],
			valid: false,
		});
	});

	it("accepts comma punctuation between separately keyworded issues", () => {
		expect(lintCloseKeywords("Closes #123, fixes #456").valid).toBe(true);
	});

	it("does not treat refs as close keywords", () => {
		expect(parseCloseKeywords("Refs #123, relates to #456")).toMatchObject({
			issues: [],
			commaLists: [],
		});
	});

	it("handles case variants and optional colon", () => {
		expect(
			parseCloseKeywords("CLOSES: #7; FiXeD #8; ResolveD #9").issues,
		).toEqual([7, 8, 9]);
	});

	it("ignores cross-repository references", () => {
		expect(
			parseCloseKeywords("Closes owner/repo#123; fixes #456"),
		).toMatchObject({
			issues: [456],
			commaLists: [],
		});
	});

	it("deduplicates repeated issue references", () => {
		expect(parseCloseKeywords("Closes #12. Fixes #12").issues).toEqual([12]);
	});

	it("exposes the exact lint failure message", () => {
		expect(INVALID_CLOSE_KEYWORD_MESSAGE).toBe(
			'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").',
		);
	});

	// #1355 review: quoted examples are documentation, not intent.
	it("ignores close keywords inside fenced code blocks", () => {
		const result = lintCloseKeywords(
			"Real.\n```\nCloses #1, #2\n```\nCloses #99.",
		);
		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([99]);
	});

	it("ignores close keywords in blockquotes and inline code", () => {
		expect(lintCloseKeywords("> Closes #1, #2\nCloses #99.").valid).toBe(true);
		expect(
			lintCloseKeywords("Use `Closes #1, #2` never. Closes #7.").valid,
		).toBe(true);
	});

	it("reports the offending line for a comma list", () => {
		const result = lintCloseKeywords("Intro.\nCloses #12, #13\nOutro.");
		expect(result.valid).toBe(false);
		expect(result.offendingLines).toEqual(["Closes #12, #13"]);
	});
});

// #2086: verifyMergedPullRequest read pullRequest.body straight off the
// closed-event payload, so a rerun after the body was edited post-merge
// always relinted the STALE body. It now reuses check-pr-body.mjs's
// resolveLivePrBody (shipped for #2085) instead of a second implementation;
// that file's own "live PR body resolution (#2085)" suite already
// mutation-proves the fallback paths (missing token, non-2xx, malformed
// body), so this file only proves the regression case parseCloseKeywords
// actually cares about: an edited body changes the lint verdict.
describe("live PR body resolution (#2086)", () => {
	const payloadPr = { number: 2086, body: "Closes #123, #456" };

	it("uses the live body when it differs from the event payload", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123. Closes #456." }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const body = await resolveLivePrBody(payloadPr, fetchImpl);
		expect(body).toBe("Closes #123. Closes #456.");
		expect(lintCloseKeywords(body).valid).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2086",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	// The regression case this issue exists for: an edit that FIXES the
	// comma-list problem must be seen on rerun, not masked by the stale
	// payload the closed event carried.
	it("sees a post-merge edit that fixes an invalid comma list", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123. Closes #456." }), {
				status: 200,
			}),
		);

		const body = await resolveLivePrBody(payloadPr, fetchImpl);
		expect(lintCloseKeywords(payloadPr.body).valid).toBe(false);
		expect(lintCloseKeywords(body).valid).toBe(true);
	});

	// The mirror case: an edit that INTRODUCES a comma list must be seen too,
	// not masked by a stale payload that looked clean at close time.
	it("sees a post-merge edit that introduces an invalid comma list", async () => {
		const cleanPayloadPr = { number: 2086, body: "Closes #123" };
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ body: "Closes #123, #456" }), {
				status: 200,
			}),
		);

		const body = await resolveLivePrBody(cleanPayloadPr, fetchImpl);
		expect(lintCloseKeywords(cleanPayloadPr.body).valid).toBe(true);
		expect(lintCloseKeywords(body).valid).toBe(false);
	});
});

// The actual regression this issue is about, exercised end to end through
// verifyMergedPullRequest itself (not just resolveLivePrBody in isolation):
// a rerun of --verify-merged must lint the LIVE body's issue references, not
// the ones frozen into the closed-event payload. Both fixture bodies name
// issues getIssueState reports as already closed, so the run always takes
// the "OK" branch and never touches the real `gh pr comment` side effects --
// the only difference under test is WHICH body's issue count gets logged.
describe("verifyMergedPullRequest reads the live body, not the stale payload (#2086)", () => {
	it("logs the live body's issue count, proving it did not use the stale payload's", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ body: "Closes #1. Closes #2." }), // live: 2 issues
				{ status: 200 },
			),
		);
		const event = {
			pull_request: { number: 2086, body: "Closes #1" }, // stale: 1 issue
		};
		const getIssueState = vi.fn().mockReturnValue("closed");

		await verifyMergedPullRequest(fetchImpl, event, getIssueState);

		// Mutation-proof: if verifyMergedPullRequest reverted to reading
		// pullRequest.body directly, this would report "1 issue" (the stale
		// payload) instead -- this exact assertion is what pins the fix, and
		// it needs no `gh` CLI, no comment-posting side effect.
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("2 issues closed"),
		);
		expect(getIssueState).toHaveBeenCalledWith("apmantza/pi-lens", 1);
		expect(getIssueState).toHaveBeenCalledWith("apmantza/pi-lens", 2);
		log.mockRestore();
	});
});
