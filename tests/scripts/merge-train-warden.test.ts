import { describe, expect, it } from "vitest";
import { applyAction, CONFLICT_LABEL, decideActions, fetchOpenPullRequests, RED_CI_LABEL, runWarden } from "../../scripts/lib/merge-train-warden.mjs";

function pr(overrides: Record<string, unknown> = {}) {
	return {
		number: 1,
		url: "https://github.com/acme/repo/pull/1",
		headSha: "abc123",
		mergeStateStatus: "CLEAN",
		autoMergeEnabled: false,
		labels: new Set<string>(),
		failingRequiredChecks: [] as Array<{ name: string; url?: string }>,
		...overrides,
	};
}

describe("merge-train warden decision logic (#1844)", () => {
	it("labels and comments once when a clean PR turns DIRTY", () => {
		const actions = decideActions(pr({ mergeStateStatus: "DIRTY" }));
		expect(actions).toEqual([
			{ type: "add-label", label: CONFLICT_LABEL },
			expect.objectContaining({ type: "comment", body: expect.stringContaining("merge-conflicted") }),
		]);
	});

	// Dedupe by label presence: mutating this to `false` (always re-add/comment)
	// must turn this test red -- that is the vacuous-guard screen.
	it("does not re-label or re-comment a PR already labeled conflict", () => {
		const actions = decideActions(pr({ mergeStateStatus: "DIRTY", labels: new Set([CONFLICT_LABEL]) }));
		expect(actions).toEqual([]);
	});

	it("removes the conflict label once the PR is clean again", () => {
		const actions = decideActions(pr({ mergeStateStatus: "CLEAN", labels: new Set([CONFLICT_LABEL]) }));
		expect(actions).toEqual([{ type: "remove-label", label: CONFLICT_LABEL }]);
	});

	it("kicks update-branch only when auto-merge is armed AND the PR is BEHIND", () => {
		expect(decideActions(pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: true }))).toContainEqual({ type: "update-branch" });
		expect(decideActions(pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: false }))).not.toContainEqual({ type: "update-branch" });
		expect(decideActions(pr({ mergeStateStatus: "CLEAN", autoMergeEnabled: true }))).not.toContainEqual({ type: "update-branch" });
	});

	it("labels and comments once when a required check fails, naming it with its run link", () => {
		const actions = decideActions(pr({ failingRequiredChecks: [{ name: "Unit tests", url: "https://example/run/9" }] }));
		expect(actions).toEqual([
			{ type: "add-label", label: RED_CI_LABEL },
			expect.objectContaining({ type: "comment", body: expect.stringContaining("Unit tests") }),
		]);
		const commentAction = actions[1] as { body: string };
		expect(commentAction.body).toContain("https://example/run/9");
	});

	it("does not re-label or re-comment a PR already labeled red-ci", () => {
		const actions = decideActions(pr({ failingRequiredChecks: [{ name: "Unit tests" }], labels: new Set([RED_CI_LABEL]) }));
		expect(actions).toEqual([]);
	});

	it("removes red-ci once every required check is green again", () => {
		const actions = decideActions(pr({ failingRequiredChecks: [], labels: new Set([RED_CI_LABEL]) }));
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	it("never proposes a merge or a push -- only label, comment, and the sanctioned update-branch kick", () => {
		const allowed = new Set(["add-label", "remove-label", "comment", "update-branch"]);
		for (const state of ["DIRTY", "BEHIND", "CLEAN", "BLOCKED", "UNSTABLE"]) {
			for (const auto of [true, false]) {
				const actions = decideActions(pr({ mergeStateStatus: state, autoMergeEnabled: auto, failingRequiredChecks: [{ name: "Unit tests" }] }));
				for (const action of actions) expect(allowed.has(action.type)).toBe(true);
			}
		}
	});
});

function fakeGithub(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		const key = `${method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
		const entry = routes[key];
		if (entry === undefined) return { ok: true, status: 200, json: async () => ({}) };
		if (typeof entry === "function") return entry(body);
		return { ok: true, status: 200, json: async () => entry };
	};
	return { fetcher, calls };
}

describe("merge-train warden GraphQL fetch + REST apply (#1844)", () => {
	it("normalizes a GraphQL page into flat PR records with failing required checks", async () => {
		const page = {
			data: {
				repository: {
					pullRequests: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								number: 7,
								url: "https://github.com/acme/repo/pull/7",
								mergeStateStatus: "DIRTY",
								autoMergeRequest: null,
								labels: { nodes: [] },
								commits: {
									nodes: [
										{
											commit: {
												oid: "deadbeef",
												statusCheckRollup: {
													contexts: {
														nodes: [
															{ __typename: "CheckRun", name: "Unit tests", conclusion: "FAILURE", detailsUrl: "https://example/run/1" },
															{ __typename: "CheckRun", name: "Lint & type-check", conclusion: "SUCCESS", detailsUrl: "https://example/run/2" },
														],
													},
												},
											},
										},
									],
								},
							},
						],
					},
				},
			},
		};
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const prs = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs).toEqual([
			expect.objectContaining({
				number: 7,
				mergeStateStatus: "DIRTY",
				headSha: "deadbeef",
				autoMergeEnabled: false,
				failingRequiredChecks: [{ name: "Unit tests", url: "https://example/run/1" }],
			}),
		]);
	});

	it("bails gracefully on a malformed page instead of throwing", async () => {
		const { fetcher } = fakeGithub({ "POST /graphql": { data: { repository: { pullRequests: { nodes: "not-an-array" } } } } });
		await expect(fetchOpenPullRequests(fetcher, "acme", "repo")).resolves.toEqual([]);
	});

	it("applyAction issues the exact REST call for each action type", async () => {
		const { fetcher, calls } = fakeGithub({});
		const record = pr({ number: 5, headSha: "abc123" });
		await applyAction(fetcher, "acme", "repo", record, { type: "add-label", label: CONFLICT_LABEL });
		await applyAction(fetcher, "acme", "repo", record, { type: "remove-label", label: CONFLICT_LABEL });
		await applyAction(fetcher, "acme", "repo", record, { type: "comment", body: "hi" });
		await applyAction(fetcher, "acme", "repo", record, { type: "update-branch" });
		expect(calls).toEqual([
			{ method: "POST", url: "https://api.github.com/repos/acme/repo/issues/5/labels", body: { labels: [CONFLICT_LABEL] } },
			{ method: "DELETE", url: "https://api.github.com/repos/acme/repo/issues/5/labels/conflict", body: undefined },
			{ method: "POST", url: "https://api.github.com/repos/acme/repo/issues/5/comments", body: { body: "hi" } },
			{ method: "PUT", url: "https://api.github.com/repos/acme/repo/pulls/5/update-branch", body: { expected_head_sha: "abc123" } },
		]);
	});

	it("records one PR's API failure without aborting the sweep over the rest", async () => {
		const page = {
			data: {
				repository: {
					pullRequests: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{ number: 1, url: "u1", mergeStateStatus: "DIRTY", autoMergeRequest: null, labels: { nodes: [] }, commits: { nodes: [] } },
							{ number: 2, url: "u2", mergeStateStatus: "DIRTY", autoMergeRequest: null, labels: { nodes: [] }, commits: { nodes: [] } },
						],
					},
				},
			},
		};
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({ ok: false, status: 422, json: async () => ({}) }),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toHaveLength(2);
		expect(results[0].errors.length).toBeGreaterThan(0);
		expect(results[1].errors).toEqual([]);
		expect(results[1].applied).toContain(`add-label:${CONFLICT_LABEL}`);
	});
});
