## Why

`ci-verdict` now prints the workflow run id required by `gh run rerun` when a superseded check-run is cancelled.

## Notes for the reviewer

- GitHub's #3382 payload proved check-run `107709801964` is the job id, while `details_url` carries workflow run `36022234159`.
- The existing check-runs payload is the only resolution seam; no second API client or workflow-run lookup was added.
- Failure list before coding: print the check-run id again; lose exit code 3; use an unverified `--job` fallback; fail when `details_url` is absent; or silently change a non-cancelled verdict.

## Change outline

```text
- run() / pollVerdict
  + computeVerdict
    + formatRerunHint
      + check-run details_url run segment
```

## Summary

`computeVerdict` carries `details_url` from the existing check-runs read into its row and formats the `/actions/runs/<run>/job/<job>` run segment for the cancellation hint. A `--job` command is used only when the same URL proves its job segment equals the check-run id; otherwise the message says the workflow run is unavailable. Exit code 3 is unchanged. Closes #3386.

## Type of change

- [x] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [ ] area:lsp
- [ ] area:dispatch
- [ ] area:installer
- [ ] area:diagnostics
- [ ] area:read-guard
- [ ] area:project-intelligence
- [ ] area:perf
- [ ] area:observability
- [ ] area:session
- [ ] area:config
- [ ] area:security
- [x] area:tests

## Checklist

- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [x] The change has tests (happy path, edge cases, regression test for bugs)
- [x] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job.
- [x] Every NEW regression test is proven RED on pre-fix code; the red output is quoted in this PR
- [x] Every new guard/branch/filter is mutation-proof: deleting or neutering it reds at least one test
- [x] PR title carries the conventional prefix and the issue ref
- [x] `npm run lint` passes
- [ ] `npm run build:dist` succeeds if I changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [x] `package-lock.json` is in sync with `package.json` (regenerate with the exact npm pin in `package.json`'s `packageManager` field)
- [ ] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [x] `.changelog/<branch-or-slug>-<short-desc>.md` has one valid entry **in this PR** for any user-facing change (Added/Changed/Deprecated/Removed/Fixed/Security) — see [.changelog/README.md](../.changelog/README.md); internal-only test/refactor PRs may skip it
- [x] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`

## Tests

- `tests/scripts/ci-verdict.test.ts`: the #3382 fixture proves `36022234159` is printed and exit code is `EXIT_PENDING` (3); the verified `--job` fallback is covered independently.
- `tests/fixtures/ci-verdict/pr-3382-cancelled.json`: scrubbed live check-run payload carrying `check_suite.id`, check-run id, and `details_url`.
- Pre-fix red on `origin/master`: `Expected: ... rerun 36022234159 (gh run rerun 36022234159); Received: ... rerun 107709801964 (gh run rerun 107709801964)`.
- Mutation red after replacing `formatRerunHint` with the old check-run-id interpolation: the same #3382 test failed with the received check-run id; all other 101 tests passed.
- `npm run build`: passed.
- `npm run lint`: passed.
- `tests/scripts/ci-verdict.test.ts`: 102 passed.
- `tests/config/vi-mock-export-sweep.test.ts`: 57 passed, 1 skipped; 119 pre-existing warning rows.
- Live `node scripts/ci-verdict.mjs 3382 --wait 1500`: exit 0; all gating checks concluded success on head `becd6dfff71dbaf37539b0dfa56395ab7cd575d0`. No cancelled row remained live, so the cancelled fixture is the live #3382 evidence.

```text
origin/master transcript: Expected: rerun 36022234159 (gh run rerun 36022234159); Received: rerun 107709801964 (gh run rerun 107709801964)
```

## Blast radius

The only production caller is `run()` through `pollVerdict` and `computeVerdict` in `scripts/ci-verdict.mjs`; `fetchCheckRunsPayload` remains unchanged and is still the sole REST read for check-runs. The changed row shape is internal to the script and its tests; the existing table, verdict precedence, and exit codes are unchanged. No client, tool, MCP, or host adapter is affected. The hot path adds one stored URL field and one regex only when rendering a cancelled-row reason.

## Observability

No new failure path; no record added.

## Class sweep

Swept `clients/`, `tools/`, `mcp/`, `scripts/`, and `index.ts` for `gh run rerun`, `run.details_url`, and check-run-id interpolation. The only superseded-cancellation renderer is `scripts/ci-verdict.mjs`; other rerun sites use distinct workflow-run or job APIs and are not consumers of this check-runs verdict row. The enumerable `ci-verdict` callers are `run()` and the test import; both remain on the same seam. Consolidation verdict: fold this renderer onto the existing `fetchCheckRunsPayload` seam; no second API client is warranted.

## Test assessment

- `tests/scripts/ci-verdict.test.ts`: uniquely pins cancellation precedence, exit code 3, the #3382 workflow-run extraction, and the verified `--job` fallback; no redundant test removed.
- `tests/config/vi-mock-export-sweep.test.ts`: unchanged governance coverage for production-module mock exports; it passed as a dependency sweep.
