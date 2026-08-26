import { describe, expect, it } from "vitest";
import {
	evaluateMergeGate,
	laneCommentMarker,
	MERGE_GATE_REASON,
	runMergeLane,
	TRAIN_APPROVED_LABEL,
	TRAIN_SQUASH_LABEL,
} from "../../scripts/lib/merge-train-lane.mjs";
import {
	applyAction,
	classifyActionFailure,
	CONFLICT_LABEL,
	decideActions,
	fetchOpenPullRequests,
	MAX_PAGES,
	PAGE_SIZE,
	RED_CI_LABEL,
	runWarden,
} from "../../scripts/lib/merge-train-warden.mjs";
import {
	absentRunCommentMarker,
	classifyHeadRun,
	countExecutedSteps,
	decideRunHealthActions,
	fetchHeadRunHealth,
	isStarvedRun,
	RUN_HEALTH,
} from "../../scripts/lib/warden-run-health.mjs";

function pr(overrides: Record<string, unknown> = {}) {
	return {
		number: 1,
		url: "https://github.com/acme/repo/pull/1",
		headSha: "abc123",
		headCommittedDate: null as string | null,
		mergeStateStatus: "CLEAN",
		autoMergeEnabled: false,
		isFork: false,
		labels: new Set<string>(),
		checksUnknown: false,
		checkRuns: [] as Array<{
			name: string;
			status: string | null;
			conclusion: string | null;
			url?: string;
		}>,
		failingRequiredChecks: [] as Array<{ name: string; url?: string }>,
		unresolvedRequiredChecks: [] as string[],
		...overrides,
	};
}

describe("merge-train warden decision logic (#1844)", () => {
	it("labels and comments once when a clean PR turns DIRTY", () => {
		const actions = decideActions(pr({ mergeStateStatus: "DIRTY" }));
		expect(actions).toEqual([
			{ type: "add-label", label: CONFLICT_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("merge-conflicted"),
			}),
		]);
	});

	// Dedupe by label presence: mutating this to `false` (always re-add/comment)
	// must turn this test red -- that is the vacuous-guard screen.
	it("does not re-label or re-comment a PR already labeled conflict", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "DIRTY", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("removes the conflict label once the PR is confirmed clean again", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "CLEAN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([{ type: "remove-label", label: CONFLICT_LABEL }]);
	});

	// Review round 1, F1: GitHub reports UNKNOWN for every open PR for a few
	// seconds after each push while it recomputes mergeability. Treating that
	// as "clean again" would strip the label, then immediately re-add it and
	// re-comment on the very next 10-minute tick.
	it("takes no conflict action while mergeStateStatus is UNKNOWN, even with the label present", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "UNKNOWN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("takes no conflict action while mergeStateStatus is UNKNOWN and unlabeled", () => {
		const actions = decideActions(pr({ mergeStateStatus: "UNKNOWN" }));
		expect(actions).toEqual([]);
	});

	it("kicks update-branch only when auto-merge is armed AND the PR is BEHIND", () => {
		expect(
			decideActions(pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: true })),
		).toContainEqual({ type: "update-branch" });
		expect(
			decideActions(
				pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: false }),
			),
		).not.toContainEqual({ type: "update-branch" });
		expect(
			decideActions(pr({ mergeStateStatus: "CLEAN", autoMergeEnabled: true })),
		).not.toContainEqual({ type: "update-branch" });
	});

	it("labels and comments once when a required check fails, naming it with its run link", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/9" },
				],
			}),
		);
		expect(actions).toEqual([
			{ type: "add-label", label: RED_CI_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("Unit tests"),
			}),
		]);
		const commentAction = actions[1] as { body: string };
		expect(commentAction.body).toContain("https://example/run/9");
	});

	it("does not re-label or re-comment a PR already labeled red-ci", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [{ name: "Unit tests" }],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	it("removes red-ci once every required check has a settled non-failure conclusion", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// Review round 1, F3: a re-queued required check reports conclusion null
	// while it reruns. Reading that as "not failing" (empty
	// failingRequiredChecks) would flap the label off and re-comment on the
	// next failure, once per re-run.
	it("does not remove red-ci while a previously-failing required check is unresolved (re-queued)", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: ["Unit tests"],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	// Review round 1, F2: a null/absent statusCheckRollup is missing
	// information, not evidence of a clean run. Must not silently strip an
	// existing red-ci label; must record why so "confirmed green" and
	// "didn't check" stay distinguishable in the run summary (an
	// empty-vs-errored guard).
	it("does not remove red-ci when the rollup is unknown, and records why", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("statusCheckRollup missing"),
			},
		]);
	});

	it("takes no red-ci action when the rollup is unknown and the PR is not labeled (nothing to protect)", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
			}),
		);
		expect(actions).toEqual([]);
	});

	it("still removes red-ci on a genuinely all-green rollup (checksUnknown false) -- distinct from the unknown-rollup case", () => {
		const actions = decideActions(
			pr({
				checksUnknown: false,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// #1959: a 403 on update-branch means two very different things depending
	// on whose branch it is. Deleting the `pr.isFork` check here (so every
	// update-branch 403 reads as benign) must turn the own-branch case below
	// red -- that is the mutation-proof screen for this branch.
	it("classifies an update-branch 403 on a fork-owned PR as the distinct benign fork outcome", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: true }),
			403,
		);
		expect(result).toEqual({
			benign: true,
			outcome: "update-branch-forbidden-fork",
		});
	});

	it("classifies an update-branch 403 on an own-branch PR as fatal, not benign", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: false }),
			403,
		);
		expect(result).toEqual({ benign: false, outcome: null });
	});

	it("leaves every other action/status pair on the existing benign-status set", () => {
		expect(
			classifyActionFailure(
				{ type: "add-label", label: CONFLICT_LABEL },
				pr({ isFork: true }),
				403,
			),
		).toEqual({ benign: false, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: true }),
				422,
			),
		).toEqual({ benign: true, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: false }),
				404,
			),
		).toEqual({ benign: true, outcome: null });
	});

	it("never proposes a merge or a push -- only label, comment, note, and the sanctioned update-branch kick", () => {
		const allowed = new Set([
			"add-label",
			"remove-label",
			"comment",
			"update-branch",
			"note",
		]);
		for (const state of [
			"DIRTY",
			"BEHIND",
			"CLEAN",
			"BLOCKED",
			"UNSTABLE",
			"UNKNOWN",
		]) {
			for (const auto of [true, false]) {
				const actions = decideActions(
					pr({
						mergeStateStatus: state,
						autoMergeEnabled: auto,
						failingRequiredChecks: [{ name: "Unit tests" }],
					}),
				);
				for (const action of actions)
					expect(allowed.has(action.type)).toBe(true);
			}
		}
	});
});

function fakeGithub(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetcher = async (
		url: string,
		init?: { method?: string; body?: string },
	) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		const key = `${method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
		const entry = routes[key];
		if (entry === undefined) {
			// Default the #2184 run-health reads to well-formed empty payloads, so
			// a test that only cares about labels/comments does not accidentally
			// assert on an "unreadable runs list" error.
			if (key.includes("/actions/runs"))
				return {
					ok: true,
					status: 200,
					json: async () => (key.endsWith("/jobs") ? { jobs: [] } : { workflow_runs: [] }),
				};
			if (key.endsWith("/comments") && method === "GET")
				return { ok: true, status: 200, json: async () => [] };
			return { ok: true, status: 200, json: async () => ({}) };
		}
		if (typeof entry === "function") return entry(body);
		return { ok: true, status: 200, json: async () => entry };
	};
	return { fetcher, calls };
}

function checkRun(
	name: string,
	conclusion: string | null,
	detailsUrl = `https://example/${name}`,
) {
	return { __typename: "CheckRun", name, conclusion, detailsUrl };
}

function graphqlPage(
	nodes: unknown[],
	hasNextPage = false,
	endCursor: string | null = null,
) {
	return {
		data: {
			repository: {
				pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes },
			},
		},
	};
}

function prNode(overrides: Record<string, unknown> = {}) {
	return {
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
						statusCheckRollup: { contexts: { nodes: [] } },
					},
				},
			],
		},
		...overrides,
	};
}

describe("merge-train warden GraphQL fetch + REST apply (#1844)", () => {
	it("normalizes a GraphQL page into flat PR records with failing required checks", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun(
												"Unit tests",
												"FAILURE",
												"https://example/run/1",
											),
											checkRun(
												"Lint & type-check",
												"SUCCESS",
												"https://example/run/2",
											),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(errors).toEqual([]);
		expect(prs).toEqual([
			expect.objectContaining({
				number: 7,
				mergeStateStatus: "DIRTY",
				headSha: "deadbeef",
				autoMergeEnabled: false,
				checksUnknown: false,
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/1" },
				],
				unresolvedRequiredChecks: [],
			}),
		]);
	});

	// Review round 1, F5: the required-checks filter must actually filter.
	// Deleting the `REQUIRED_CHECKS.includes(c.name)` guard in normalizePr
	// (so any failing check counts, including non-required ones) must turn
	// this test red.
	it("ignores a failing check that is not in REQUIRED_CHECKS (e.g. SonarCloud)", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [checkRun("SonarCloud Code Analysis", "FAILURE")],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("marks a required check missing from the rollup as unresolved, not passing", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", "SUCCESS")] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual(["Lint & type-check"]);
	});

	it("marks a re-queued required check (conclusion null) as unresolved", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", null)] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].unresolvedRequiredChecks).toContain("Unit tests");
		expect(prs[0].failingRequiredChecks).toEqual([]);
	});

	it("flags checksUnknown when statusCheckRollup is null", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [{ commit: { oid: "deadbeef", statusCheckRollup: null } }],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].checksUnknown).toBe(true);
	});

	it("bails gracefully on a malformed page instead of throwing", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: { repository: { pullRequests: { nodes: "not-an-array" } } },
			},
		});
		await expect(
			fetchOpenPullRequests(fetcher, "acme", "repo"),
		).resolves.toEqual({ prs: [], errors: [] });
	});

	// Review round 1, F6: GraphQL can return partial `data` alongside
	// `errors`. This must be skip-and-record, not an uncaught throw out of
	// the bare top-level await in the CLI entry point.
	it("records GraphQL errors instead of throwing, keeping any partial data collected", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [prNode({ number: 1 })],
						},
					},
				},
				errors: [{ message: "some field errored" }],
			},
		});
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toHaveLength(1);
		expect(errors[0]).toContain("some field errored");
	});

	it("records a thrown GraphQL request failure instead of propagating", async () => {
		const fetcher = async () => {
			throw new Error("network down");
		};
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toEqual([]);
		expect(errors[0]).toContain("network down");
	});

	// #2134: a full final page with hasNextPage is not an exhausted result.
	// The page-aware fixture makes a cursor bug visible instead of returning
	// the same page for every request.
	it("records truncation when MAX_PAGES pages still claim another page", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				true,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([
			`GraphQL pagination truncated after ${MAX_PAGES} pages while hasNextPage=true`,
		]);
	});

	// The page limit is healthy when the final page exhausts the connection.
	// Hoisting the truncation guard above the hasNextPage break must make this
	// complete population report a false error.
	it("accepts MAX_PAGES full pages when the last page is exhausted", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				pageIndex < MAX_PAGES - 1,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([]);
	});

	it("applyAction issues the exact REST call for each action type", async () => {
		const { fetcher, calls } = fakeGithub({});
		const record = pr({ number: 5, headSha: "abc123" });
		await applyAction(fetcher, "acme", "repo", record, {
			type: "add-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "remove-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "comment",
			body: "hi",
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "update-branch",
		});
		expect(calls).toEqual([
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels",
				body: { labels: [CONFLICT_LABEL] },
			},
			{
				method: "DELETE",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels/conflict",
				body: undefined,
			},
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/comments",
				body: { body: "hi" },
			},
			{
				method: "PUT",
				url: "https://api.github.com/repos/acme/repo/pulls/5/update-branch",
				body: { expected_head_sha: "abc123" },
			},
		]);
	});

	it("records one PR's API failure without aborting the sweep over the rest", async () => {
		const page = graphqlPage([
			prNode({ number: 1, url: "u1" }),
			prNode({ number: 2, url: "u2" }),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toHaveLength(2);
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 500"), benign: false },
		]);
		expect(results[1].errors).toEqual([]);
		expect(results[1].applied).toContain(`add-label:${CONFLICT_LABEL}`);
	});

	// Review round 1, F4: a closed/deleted PR (404), a racing label add (409),
	// or an update-branch on a fork with maintainer edits off (422) are
	// expected noise on a 10-minute cadence -- they must be recorded but must
	// NOT be counted as a reason for the scheduled run to exit non-zero.
	it("classifies 404/409/422 REST failures as benign, and everything else as fatal", async () => {
		const page = graphqlPage([prNode({ number: 1 })]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 404,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 404"), benign: true },
		]);
	});

	// #1959, AC2: the run-level classification must actually reach runWarden's
	// error stream, not just the pure classifyActionFailure unit above.
	it("records an update-branch 403 on a fork-owned BEHIND PR as benign with the fork outcome, not a failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: true,
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{
				message: expect.stringContaining("update-branch-forbidden-fork"),
				benign: true,
			},
		]);
		// Review round 2, F2: this is the wiring guard for isFork itself.
		// Deleting `isCrossRepository` from PR_QUERY leaves normalizePr's
		// `Boolean(node.isCrossRepository)` silently reading `undefined` as
		// `false` on every real PR -- the whole fork branch above would then
		// go dead in production while every one of these tests (which fake
		// the GraphQL response by hand) stays green. Assert the query text
		// itself requests the field, so removing it fails here first.
		const graphqlCall = calls.find((c) => c.url.endsWith("/graphql"));
		expect(
			String((graphqlCall?.body as { query?: string } | undefined)?.query),
		).toContain("isCrossRepository");
	});

	it("records an update-branch 403 on an own-branch BEHIND PR as a fatal failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: false,
			}),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 403"), benign: false },
		]);
	});

	it("records a list-level GraphQL error as its own result entry with number: null", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: null,
				errors: [{ message: "resource not accessible" }],
			},
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toEqual([
			{
				number: null,
				url: null,
				mergeStateStatus: null,
				applied: [],
				errors: [
					{
						message: expect.stringContaining("resource not accessible"),
						benign: false,
					},
				],
				runHealth: null,
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// #2184: starved and absent workflow runs
// ---------------------------------------------------------------------------

/**
 * The starved-run fixture is transcribed from the REAL incident run
 * 32986328966 (`.github/workflows/ci.yml` on head 8e32f127, conclusion
 * `failure`, `run_attempt` 1), read with `gh api` on 2026-08-26: six jobs at
 * `status: "queued"` with no steps, plus one matrix job GitHub marked
 * `completed`/`skipped` with no steps. That last job is why "every job is
 * queued" is the WRONG predicate.
 */
function starvedJobs() {
	return [
		{ name: "Lint & type-check", status: "queued", conclusion: null, steps: [] },
		{ name: "Unit tests", status: "queued", conclusion: null, steps: [] },
		{ name: "Close-keyword syntax", status: "queued", conclusion: null, steps: [] },
		{ name: "Dependency boundaries", status: "queued", conclusion: null, steps: [] },
		{
			name: "Changelog fragment (fast-fail)",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Production install build (--omit=dev, from source)",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Install test (${{ matrix.os }})",
			status: "completed",
			conclusion: "skipped",
			steps: [],
		},
	];
}

function executedJobs() {
	return [
		{
			name: "Unit tests",
			status: "completed",
			conclusion: "failure",
			steps: [
				{ name: "Set up job", status: "completed", conclusion: "success" },
				{ name: "npm test", status: "completed", conclusion: "failure" },
			],
		},
	];
}

function headRun(overrides: Record<string, unknown> = {}) {
	return {
		id: 32986328966,
		path: ".github/workflows/ci.yml",
		name: "CI",
		status: "completed",
		conclusion: "failure",
		runAttempt: 1,
		url: "https://github.com/acme/repo/actions/runs/32986328966",
		createdAt: "2026-08-26T15:54:50Z",
		jobs: starvedJobs(),
		...overrides,
	};
}

const NOW = Date.parse("2026-08-26T16:30:00Z");

describe("starved-run detection (#2184)", () => {
	it("counts only steps GitHub actually executed", () => {
		expect(countExecutedSteps(starvedJobs())).toBe(0);
		expect(countExecutedSteps(executedJobs())).toBe(2);
		expect(countExecutedSteps(null)).toBe(0);
	});

	// The red-first anchor for the whole starved class: this is the real
	// incident run's shape, and nothing in the pre-#2184 warden classified it.
	it("classifies the real incident run (failure, zero executed steps) as starved", () => {
		expect(isStarvedRun(headRun())).toBe(true);
		const health = classifyHeadRun({
			runs: [headRun(), headRun({ id: 2, path: ".github/workflows/lint.yml" })],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		expect(health.starvedRuns.map((r) => r.path)).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]);
	});

	// Mutation screen for the zero-executed-steps guard: widening the
	// predicate to "concluded failure" alone makes every genuinely red PR look
	// starved and re-runs it, which is exactly the failure this feature must
	// not introduce.
	it("does NOT call a genuinely failing run starved -- its jobs executed steps", () => {
		expect(isStarvedRun(headRun({ jobs: executedJobs() }))).toBe(false);
		const health = classifyHeadRun({
			runs: [
				headRun({ jobs: executedJobs() }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.NORMAL);
		expect(health.starvedRuns).toEqual([]);
	});

	// A human cancelling a run also produces zero executed steps. Re-running it
	// would fight the person who cancelled it.
	it("does NOT call a cancelled zero-step run starved", () => {
		expect(isStarvedRun(headRun({ conclusion: "cancelled" }))).toBe(false);
	});

	it("treats a startup_failure with no jobs at all as starved", () => {
		expect(isStarvedRun(headRun({ conclusion: "startup_failure", jobs: [] }))).toBe(
			true,
		);
	});

	// Shape 10: an unreadable jobs list is missing information, not evidence.
	it("classifies a failed run whose jobs could not be read as unknown, not starved", () => {
		expect(isStarvedRun(headRun({ jobs: null }))).toBe(false);
		const health = classifyHeadRun({
			runs: [
				headRun({ jobs: null }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.unknownWorkflows).toEqual([".github/workflows/ci.yml"]);
	});

	// The incident head carried an earlier lint.yml SUCCESS and a later
	// lint.yml starved failure. Reading the older one wins the wrong answer.
	it("judges the newest run per workflow, not the first one GitHub returns", () => {
		const health = classifyHeadRun({
			runs: [
				headRun({
					id: 1,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					createdAt: "2026-08-26T15:40:00Z",
					jobs: executedJobs(),
				}),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					createdAt: "2026-08-26T15:54:50Z",
				}),
				headRun({ id: 3, jobs: executedJobs(), conclusion: "success" }),
			],
			headCommittedDate: "2026-08-26T15:39:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		expect(health.starvedRuns.map((r) => r.id)).toEqual([2]);
	});
});

describe("absent-run detection (#2184)", () => {
	it("classifies a head with no tracked run past the grace window as absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.ABSENT);
		expect(health.absentWorkflows).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]);
		expect(health.ageMinutes).toBe(30);
	});

	// Mutation screen for the grace window: deleting it makes the warden shout
	// "dropped dispatch" at every PR in the seconds between push and dispatch.
	it("classifies a freshly pushed head with no run yet as pending, not absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: "2026-08-26T16:28:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
		expect(health.absentWorkflows).toEqual([]);
		expect(health.pendingWorkflows).toHaveLength(2);
	});

	it("classifies a head with no readable commit date as unknown, not absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: null,
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.absentWorkflows).toEqual([]);
	});

	it("reports absence per workflow when only one of the two dispatched", () => {
		const health = classifyHeadRun({
			runs: [headRun({ conclusion: "success", jobs: executedJobs() })],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.ABSENT);
		expect(health.absentWorkflows).toEqual([".github/workflows/lint.yml"]);
	});

	it("classifies an in-flight run as pending, never as concluded normally", () => {
		const health = classifyHeadRun({
			runs: [
				headRun({ status: "in_progress", conclusion: null, jobs: [] }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
	});
});

describe("run-health recovery actions (#2184)", () => {
	const starvedHealth = () => ({
		classification: RUN_HEALTH.STARVED,
		starvedRuns: [headRun()],
		absentWorkflows: [],
		unknownWorkflows: [],
		pendingWorkflows: [],
		ageMinutes: 36,
	});

	it("re-runs a starved run on its first attempt", () => {
		expect(decideRunHealthActions(pr(), starvedHealth(), {})).toEqual([
			{
				type: "rerun-run",
				runId: 32986328966,
				workflowPath: ".github/workflows/ci.yml",
			},
		]);
	});

	// Mutation screen for rerun idempotence: GitHub's own run_attempt counter
	// is the dedupe key. Deleting the check re-runs the same starved run every
	// 10 minutes for as long as the outage lasts.
	it("does NOT re-run a starved run the warden already re-ran (attempt 2)", () => {
		const health = starvedHealth();
		health.starvedRuns = [headRun({ runAttempt: 2 })];
		const actions = decideRunHealthActions(pr(), health, {});
		expect(actions).toEqual([
			{
				type: "note",
				benign: false,
				message: expect.stringContaining("STARVED again on attempt 2"),
			},
		]);
		expect(actions.some((a) => a.type === "rerun-run")).toBe(false);
	});

	it("comments once per head when the dispatch is absent, carrying the head marker", () => {
		const actions = decideRunHealthActions(
			pr({ headSha: "cafe1234" }),
			{
				classification: RUN_HEALTH.ABSENT,
				starvedRuns: [],
				absentWorkflows: [".github/workflows/ci.yml"],
				unknownWorkflows: [],
				pendingWorkflows: [],
				ageMinutes: 30,
			},
			{ absentCommentExists: false },
		);
		expect(actions).toEqual([
			{
				type: "comment",
				body: expect.stringContaining(absentRunCommentMarker("cafe1234")),
			},
		]);
		expect((actions[0] as { body: string }).body).toContain("never dispatched");
	});

	// Mutation screen for absent-comment dedupe.
	it("does not repeat the absent-run comment while one already exists for this head", () => {
		const actions = decideRunHealthActions(
			pr({ headSha: "cafe1234" }),
			{
				classification: RUN_HEALTH.ABSENT,
				starvedRuns: [],
				absentWorkflows: [".github/workflows/ci.yml"],
				unknownWorkflows: [],
				pendingWorkflows: [],
				ageMinutes: 30,
			},
			{ absentCommentExists: true },
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("comment already posted"),
			},
		]);
	});

	it("proposes nothing for a healthy head", () => {
		expect(
			decideRunHealthActions(
				pr(),
				{
					classification: RUN_HEALTH.NORMAL,
					starvedRuns: [],
					absentWorkflows: [],
					unknownWorkflows: [],
					pendingWorkflows: [],
					ageMinutes: 5,
				},
				{},
			),
		).toEqual([]);
	});
});

describe("run-health reads (#2184)", () => {
	it("reads jobs only for FAILED tracked runs, never for healthy ones", async () => {
		const { fetcher, calls } = fakeGithub({
			"GET /repos/acme/repo/actions/runs": {
				workflow_runs: [
					{
						id: 1,
						path: ".github/workflows/ci.yml",
						status: "completed",
						conclusion: "failure",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
					{
						id: 2,
						path: ".github/workflows/lint.yml",
						status: "completed",
						conclusion: "success",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
					{
						id: 3,
						path: ".github/workflows/osv-scan.yml",
						status: "completed",
						conclusion: "failure",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
				],
			},
			"GET /repos/acme/repo/actions/runs/1/jobs": { jobs: starvedJobs() },
		});
		const { health, errors } = await fetchHeadRunHealth(
			fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T15:54:00Z",
			NOW,
		);
		expect(errors).toEqual([]);
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		const jobCalls = calls.filter((c) => c.url.includes("/jobs"));
		expect(jobCalls).toHaveLength(1);
		expect(jobCalls[0].url).toContain("/actions/runs/1/jobs");
	});

	// Shape 10 again, at the network seam: an API outage must not turn every
	// open PR into a loud "GitHub dropped your dispatch" comment.
	it("classifies an errored runs read as unknown, never as absent", async () => {
		const { fetcher } = fakeGithub({
			"GET /repos/acme/repo/actions/runs": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const { health, errors } = await fetchHeadRunHealth(
			fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T15:00:00Z",
			NOW,
		);
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.absentWorkflows).toEqual([]);
		expect(errors[0]).toContain("HTTP 500");
	});
});

function runsRoute(runs: unknown[]) {
	return { workflow_runs: runs };
}

describe("warden sweep with run health (#2184)", () => {
	const starvedRunPayload = {
		id: 77,
		path: ".github/workflows/ci.yml",
		status: "completed",
		conclusion: "failure",
		run_attempt: 1,
		created_at: "2026-08-26T15:54:50Z",
	};

	it("re-runs a starved run once and records the classification in the sweep", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:54:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([
				starvedRunPayload,
				{
					id: 78,
					path: ".github/workflows/lint.yml",
					status: "completed",
					conclusion: "success",
					run_attempt: 1,
					created_at: "2026-08-26T15:54:50Z",
				},
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: starvedJobs() },
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		const reruns = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/actions/runs/77/rerun"),
		);
		expect(reruns).toHaveLength(1);
		expect(results[0].runHealth).toEqual({
			classification: RUN_HEALTH.STARVED,
			detail: expect.stringContaining("starved .github/workflows/ci.yml run 77"),
		});
		expect(results[0].applied).toContain(
			"rerun-run:.github/workflows/ci.yml#77",
		);
	});

	it("does not re-run a starved run already on attempt 2, and marks the run red", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:54:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{ ...starvedRunPayload, run_attempt: 2 },
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: starvedJobs() },
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(calls.some((c) => c.url.includes("/rerun"))).toBe(false);
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("STARVED again on attempt 2"),
			benign: false,
		});
	});

	it("comments once on an absent dispatch and never twice for the same head", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:00:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const first = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
		});
		await runWarden({
			fetcher: first.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		const posted = first.calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(posted).toHaveLength(1);
		expect(String((posted[0].body as { body: string }).body)).toContain(
			absentRunCommentMarker("deadbeef"),
		);

		const second = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
			"GET /repos/acme/repo/issues/7/comments": [
				{ body: (posted[0].body as { body: string }).body },
			],
		});
		await runWarden({
			fetcher: second.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(
			second.calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
	});

	it("names a run-health classification for every swept PR, even a quiet one", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T16:29:00Z",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun("Unit tests", "SUCCESS"),
											checkRun("Lint & type-check", "SUCCESS"),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].applied).toEqual([]);
		expect(results[0].runHealth?.classification).toBe(RUN_HEALTH.PENDING);
	});
});

// ---------------------------------------------------------------------------
// #2185: the label-gated merge lane
// ---------------------------------------------------------------------------

const HEALTHY = {
	classification: RUN_HEALTH.NORMAL,
	starvedRuns: [],
	absentWorkflows: [],
	unknownWorkflows: [],
	pendingWorkflows: [],
	ageMinutes: 20,
};

function greenChecks() {
	return [
		{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
		{ name: "Lint & type-check", status: "COMPLETED", conclusion: "SUCCESS" },
	];
}

function approved(overrides: Record<string, unknown> = {}) {
	return pr({
		labels: new Set([TRAIN_APPROVED_LABEL]),
		checkRuns: greenChecks(),
		...overrides,
	});
}

describe("merge-lane gate (#2185)", () => {
	it("merges an approved PR whose current head concluded green", () => {
		const gate = evaluateMergeGate(approved(), HEALTHY);
		expect(gate).toMatchObject({
			merge: true,
			method: "merge",
			reason: MERGE_GATE_REASON.GREEN,
		});
	});

	it("uses the squash method when the PR also carries train:squash", () => {
		const gate = evaluateMergeGate(
			approved({
				labels: new Set([TRAIN_APPROVED_LABEL, TRAIN_SQUASH_LABEL]),
			}),
			HEALTHY,
		);
		expect(gate).toMatchObject({ merge: true, method: "squash" });
	});

	// The label IS the review verdict. Without it the lane is invisible: no
	// merge, and no comment either.
	it("never touches or comments on an unlabeled PR", () => {
		const gate = evaluateMergeGate(pr({ checkRuns: greenChecks() }), HEALTHY);
		expect(gate).toMatchObject({
			merge: false,
			silent: true,
			reason: MERGE_GATE_REASON.NOT_APPROVED,
		});
	});

	// AC2 + AGENTS.md shape 11. This is also the head-change re-gate: a fix
	// round's new head has no check runs yet, so the gate reads absent.
	it("treats an absent required check as not-green (the head-change re-gate)", () => {
		const gate = evaluateMergeGate(
			approved({ headSha: "newhead", checkRuns: [] }),
			HEALTHY,
		);
		expect(gate).toMatchObject({
			merge: false,
			silent: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		});
		expect(gate.detail).toContain("absent required check is not a passing one");
	});

	it("treats a required check still in progress as not-green", () => {
		const gate = evaluateMergeGate(
			approved({
				checkRuns: [
					{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null },
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
			HEALTHY,
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
		});
	});

	// Mutation screen: a gate that reads STATUS instead of CONCLUSION merges a
	// PR whose required check completed and FAILED.
	it("treats a completed-but-failed required check as not-green", () => {
		const gate = evaluateMergeGate(
			approved({
				checkRuns: [
					{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" },
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
			HEALTHY,
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_NOT_SUCCESS,
		});
	});

	it("treats a missing check rollup as not-green", () => {
		const gate = evaluateMergeGate(
			approved({ checksUnknown: true }),
			HEALTHY,
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.CHECKS_UNKNOWN,
		});
	});

	// AC3: composes with #2184. Both required checks can read SUCCESS from an
	// earlier attempt while the head's current run is starved or never fired.
	it("treats a starved run health as not-green even with green required checks", () => {
		const gate = evaluateMergeGate(approved(), {
			...HEALTHY,
			classification: RUN_HEALTH.STARVED,
		});
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
		});
	});

	it("treats an absent run health as not-green even with green required checks", () => {
		const gate = evaluateMergeGate(approved(), {
			...HEALTHY,
			classification: RUN_HEALTH.ABSENT,
		});
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
		});
	});

	it("blocks on a failing non-advisory check and allows a failing advisory one", () => {
		expect(
			evaluateMergeGate(
				approved({
					checkRuns: [
						...greenChecks(),
						{ name: "Install test (ubuntu)", status: "COMPLETED", conclusion: "FAILURE" },
					],
				}),
				HEALTHY,
			),
		).toMatchObject({ merge: false, reason: MERGE_GATE_REASON.FAILING_CHECK });
		expect(
			evaluateMergeGate(
				approved({
					mergeStateStatus: "UNSTABLE",
					checkRuns: [
						...greenChecks(),
						{
							name: "SonarCloud Code Analysis",
							status: "COMPLETED",
							conclusion: "FAILURE",
						},
					],
				}),
				HEALTHY,
			),
		).toMatchObject({ merge: true });
	});

	it("merges from CLEAN and BEHIND, and never from DIRTY, BLOCKED, or UNKNOWN", () => {
		for (const state of ["CLEAN", "BEHIND"]) {
			expect(
				evaluateMergeGate(approved({ mergeStateStatus: state }), HEALTHY),
			).toMatchObject({ merge: true });
		}
		for (const state of ["DIRTY", "BLOCKED", "DRAFT", "UNKNOWN"]) {
			expect(
				evaluateMergeGate(approved({ mergeStateStatus: state }), HEALTHY),
			).toMatchObject({ merge: false, reason: MERGE_GATE_REASON.MERGE_STATE });
		}
	});
});

function lanePrNode(overrides: Record<string, unknown> = {}) {
	const {
		labels = [],
		checks = greenChecks(),
		committedDate = "2026-08-26T16:00:00Z",
		...rest
	} = overrides as {
		labels?: string[];
		checks?: Array<{ name: string; status: string; conclusion: string | null }>;
		committedDate?: string;
	} & Record<string, unknown>;
	return prNode({
		number: 7,
		mergeStateStatus: "CLEAN",
		labels: { nodes: labels.map((name) => ({ name })) },
		commits: {
			nodes: [
				{
					commit: {
						oid: "deadbeef",
						committedDate,
						statusCheckRollup: {
							contexts: {
								nodes: checks.map((c) => ({
									__typename: "CheckRun",
									name: c.name,
									status: c.status,
									conclusion: c.conclusion,
									detailsUrl: `https://example/${c.name}`,
								})),
							},
						},
					},
				},
			],
		},
		...rest,
	});
}

const HEALTHY_RUNS = [
	{
		id: 1,
		path: ".github/workflows/ci.yml",
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: "2026-08-26T16:05:00Z",
	},
	{
		id: 2,
		path: ".github/workflows/lint.yml",
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: "2026-08-26T16:05:00Z",
	},
];

describe("merge-lane sweep (#2185)", () => {
	it("merges an approved green PR with the exact head SHA and comments", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ number: 7, merged: true });
		expect(calls).toContainEqual({
			method: "PUT",
			url: "https://api.github.com/repos/acme/repo/pulls/7/merge",
			body: { merge_method: "merge", sha: "deadbeef" },
		});
		const comments = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(comments).toHaveLength(1);
		expect(String((comments[0].body as { body: string }).body)).toContain(
			"merged",
		);
	});

	// AC1's second half, and the mutation screen for the label gate: an
	// unlabeled PR must cost ZERO calls beyond the shared list read.
	it("issues no call at all for an unlabeled PR", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([lanePrNode({ labels: [] })]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.github.com/graphql");
	});

	// AC2: the head moved after labeling, so the new head has no concluded
	// checks. The label survives (the lane never removes it) and the PR gets a
	// comment saying the lane is waiting.
	it("holds a labeled PR whose head changed, keeps the label, and says it is waiting", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL], checks: [] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		});
		expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);
		expect(
			calls.some(
				(c) =>
					c.method === "DELETE" && c.url.includes(encodeURIComponent("train:")),
			),
		).toBe(false);
		const comment = calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(String((comment?.body as { body: string }).body)).toContain(
			"label stays on",
		);
	});

	it("does not repeat the same hold comment for the same head and reason", async () => {
		const marker = laneCommentMarker(
			"deadbeef",
			MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL], checks: [] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"GET /repos/acme/repo/issues/7/comments": [{ body: `held\n${marker}` }],
		});
		await runMergeLane({ fetcher, owner: "acme", repo: "repo", now: NOW });
		expect(
			calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
	});

	// AC3 at the sweep level: green checks plus a starved run must not merge.
	it("refuses to merge a green-looking PR whose head run is starved", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{
					id: 9,
					path: ".github/workflows/ci.yml",
					status: "completed",
					conclusion: "failure",
					run_attempt: 1,
					created_at: "2026-08-26T16:05:00Z",
				},
				HEALTHY_RUNS[1],
			]),
			"GET /repos/acme/repo/actions/runs/9/jobs": { jobs: starvedJobs() },
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
			runHealth: RUN_HEALTH.STARVED,
		});
		expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);
	});

	it("records a 409 from a head that moved mid-cycle as benign, and comments", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": () => ({
				ok: false,
				status: 409,
				json: async () => ({}),
			}),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].merged).toBe(false);
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("HTTP 409"),
			benign: true,
		});
		expect(
			calls.some(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toBe(true);
	});
});
