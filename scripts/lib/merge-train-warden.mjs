/**
 * Merge-train warden (#1844): the mechanical version of the checks a human
 * was running session-side across the 2026-08-20 release drive -- polling
 * open PRs for merge conflicts, stale auto-merge, and red required checks.
 *
 * The warden OBSERVES AND ANNOTATES ONLY. It never resolves conflicts,
 * never merges, and never pushes to a PR branch. The one exception is the
 * GitHub-sanctioned "update branch" kick for a PR that already has auto-merge
 * armed and has fallen BEHIND -- that is the same button a human clicks in
 * the PR UI, exposed here as the API GitHub documents for it.
 */

export const CONFLICT_LABEL = "conflict";
export const RED_CI_LABEL = "red-ci";
export const REQUIRED_CHECKS = ["Unit tests", "Lint & type-check"];
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4; // 200 open PRs is far above this repo's steady state; bail rather than loop forever.

const PR_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        url
        mergeStateStatus
        autoMergeRequest { enabledAt }
        labels(first: 50) { nodes { name } }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      detailsUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

async function graphql(fetcher, query, variables) {
  const response = await fetcher("https://api.github.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL API ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(`GitHub GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  return payload.data;
}

function normalizePr(node) {
  const labels = new Set((node.labels?.nodes ?? []).map((l) => l.name));
  const headCommit = node.commits?.nodes?.[0]?.commit;
  const contexts = headCommit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failingRequiredChecks = contexts
    .filter((c) => c.__typename === "CheckRun" && REQUIRED_CHECKS.includes(c.name) && c.conclusion === "FAILURE")
    .map((c) => ({ name: c.name, url: c.detailsUrl }));
  return {
    number: node.number,
    url: node.url,
    headSha: headCommit?.oid,
    mergeStateStatus: node.mergeStateStatus,
    autoMergeEnabled: Boolean(node.autoMergeRequest),
    labels,
    failingRequiredChecks,
  };
}

/**
 * Single paginated list call (per PR, bounded by MAX_PAGES): rate-limit
 * conscious by construction. If GitHub returns a non-array/malformed page,
 * bail gracefully with whatever was collected rather than throwing away
 * partial progress or looping unboundedly.
 */
export async function fetchOpenPullRequests(fetcher, owner, name) {
  const prs = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(fetcher, PR_QUERY, { owner, name, after });
    const connection = data?.repository?.pullRequests;
    if (!connection || !Array.isArray(connection.nodes)) break;
    for (const node of connection.nodes) prs.push(normalizePr(node));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return prs;
}

/**
 * Decide what the warden should do for one PR. Pure function, no I/O --
 * this is what a test drives without a network mock. Dedupe is structural:
 * a comment is proposed only on the transition INTO a labeled state (label
 * absent -> label needed), never while the label already sits on the PR.
 */
export function decideActions(pr) {
  const actions = [];
  const isDirty = pr.mergeStateStatus === "DIRTY";
  const hasConflictLabel = pr.labels.has(CONFLICT_LABEL);
  if (isDirty && !hasConflictLabel) {
    actions.push({ type: "add-label", label: CONFLICT_LABEL });
    actions.push({
      type: "comment",
      body: "<!-- pi-lens-merge-train-warden:conflict -->\nThis PR is merge-conflicted; required checks are silently skipped until resolved.",
    });
  } else if (!isDirty && hasConflictLabel) {
    actions.push({ type: "remove-label", label: CONFLICT_LABEL });
  }

  if (pr.autoMergeEnabled && pr.mergeStateStatus === "BEHIND") {
    actions.push({ type: "update-branch" });
  }

  const hasRedCiLabel = pr.labels.has(RED_CI_LABEL);
  if (pr.failingRequiredChecks.length > 0 && !hasRedCiLabel) {
    actions.push({ type: "add-label", label: RED_CI_LABEL });
    const lines = pr.failingRequiredChecks.map((c) => `- **${c.name}** failed${c.url ? ` — ${c.url}` : ""}`);
    actions.push({
      type: "comment",
      body: `<!-- pi-lens-merge-train-warden:red-ci -->\nA required check is failing on the current head:\n\n${lines.join("\n")}`,
    });
  } else if (pr.failingRequiredChecks.length === 0 && hasRedCiLabel) {
    actions.push({ type: "remove-label", label: RED_CI_LABEL });
  }

  return actions;
}

async function restJson(fetcher, method, url, body) {
  const response = await fetcher(url, {
    method,
    headers: { accept: "application/vnd.github+json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

/**
 * Apply one decided action against the REST API. Every failure is caught by
 * the caller (runWarden) and recorded per-PR -- one PR's API hiccup must
 * never abort the run for every other open PR.
 */
export async function applyAction(fetcher, owner, repo, pr, action) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  switch (action.type) {
    case "add-label":
      return restJson(fetcher, "POST", `${base}/issues/${pr.number}/labels`, { labels: [action.label] });
    case "remove-label":
      return restJson(fetcher, "DELETE", `${base}/issues/${pr.number}/labels/${encodeURIComponent(action.label)}`);
    case "comment":
      return restJson(fetcher, "POST", `${base}/issues/${pr.number}/comments`, { body: action.body });
    case "update-branch":
      return restJson(fetcher, "PUT", `${base}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.headSha });
    default:
      throw new Error(`unknown warden action type: ${action.type}`);
  }
}

/**
 * Run the warden over every open PR. Returns a per-PR log so the caller can
 * print a run summary; a PR whose API calls fail is recorded but does not
 * stop the sweep over the rest of the list.
 */
export async function runWarden({ fetcher, owner, repo }) {
  const prs = await fetchOpenPullRequests(fetcher, owner, repo);
  const results = [];
  for (const pr of prs) {
    const actions = decideActions(pr);
    const applied = [];
    const errors = [];
    for (const action of actions) {
      try {
        const response = await applyAction(fetcher, owner, repo, pr, action);
        if (!response.ok) errors.push(`${action.type} ${action.label ?? ""} -> HTTP ${response.status}`.trim());
        else applied.push(action.type + (action.label ? `:${action.label}` : ""));
      } catch (error) {
        errors.push(`${action.type} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    results.push({ number: pr.number, url: pr.url, mergeStateStatus: pr.mergeStateStatus, applied, errors });
  }
  return results;
}
