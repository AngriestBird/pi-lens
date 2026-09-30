# Reviewer contract

## Mission

- Read the issue, full merge-base diff, `AGENTS.md`,
  `docs/pi-lens-subagent.md`, the PR body, and merge state.
- Keep the branch and worktree read-only.
- Reproduce the claimed behavior through the production entry point.
- Report only proven findings; do not repair the author's branch.

## Standard mechanics

- Write `REVIEW.md` as a file at the worktree root, not only in the final
  answer. Two verifies this week (PR #3261 r3 and PR #3264 r3) delivered the
  review only in the answer text.
- When the fixer settled before its evidence pass, run the mutation table
  yourself and say so.

## Verification

- Use `git diff origin/master...HEAD` or the merge-base equivalent.
- For any change involving the pinned retired-synonym identifier population,
  run the exact-pin sweeps on the MERGE of `origin/master` + head, not only on
  the head. `tests/config/glossary-synonym-sweep.test.ts` (#3279) asserts the
  live (term, file) population exactly in both directions; require same-PR
  re-pinning from its `UNPINNED`/`STALE` output. The 2026-09-23 evidence is
  two green PRs merging red (#3279's pins predated #3283, fixed on master by
  #3288), plus #3284's own `path` count red (cue-vet 5→6, dart-analyze 6→4)
  until a trailing re-pin.
- Build and run the targeted and required governance suites.
- Flag any new rule predicate added outside its owning domain module; consumers
  must ask the owner rather than re-derive its rule (#3781, #3794, #3796).
- Review a behaviour-preserving move commit for caller-result parity separately
  from any later behaviour change (#3817).
- **Name the behaviour population; never clear a seam from a curated list.**
  When a change replaces, moves, or widens a lifecycle, dispatch, or ownership
  seam, enumerate EVERY suite that exercises the behaviour the seam governs,
  run them all, and name the list in the review. A hand-picked file set cannot
  clear the behaviour it omits. Evidence: PR #3622's registry seam was called
  merge-ready after a seven-file run that omitted
  `tests/clients/lsp/service-crash-respawn.test.ts` and
  `tests/clients/lsp/service-notify-per-server.test.ts` — the two suites that
  exercise idle eviction — and both were red on the required Unit tests.
- **Population screen (generalization verdict).** When a PR applies a mechanism,
  policy, guard, or optimisation to a named subset of a larger set (registry
  entries, servers, tools, languages, stores), name the population M, state why
  the other M−N are excluded and what their default is, and end with a
  **Generalization verdict**: *widen in this PR* / *follow-up issue* (with its
  seam group) / *stay specific* (with the reason). A missing verdict is a
  finding. Recurrence: #3622. The optional ast-grep assist is #3684.
- Revert or neuter the source fix and verify the red-first test fails.
- **Check that the model covers the change, not only that TLC is green.** When
  the diff touches a file mapped in `formal/coverage-map.json`, require either
  a `.tla`/`.cfg` change under any one of the row's families or a `TLA+
  unaffected: <family> — <reason>` line in the PR body for any one of them
  (rows of 4+ families only print a note). A green `TLA+ models` run over an unchanged
  model proves nothing about the new code (#3802).
- Mutation evidence: read the `Mutation diff` comment for the EXACT head. The
  sticky can describe an older or cancelled head, so check its `Head:` line
  (`node scripts/ci-verdict.mjs <pr>` prints `MUTATION` with `STALE` or
  `PENDING`). Every survivor on an added line is killed by a test folded into
  the PR or shown equivalent with a reason; triage "truncated test population"
  survivors, never auto-accept them. Spot-check at most one of the fixer's hand
  mutations instead of re-running the table. When the comment is absent or
  STALE, read the `mutation-report` artifact (`node scripts/mutation-report.mjs
  --report <downloaded mutation.json>`). Absent, stale, `0 mutants evaluated`,
  partial or `no report` mutation evidence goes under `Could not verify`, never
  implied green.
- Probe inversions, concurrency, input channels, trust boundaries, strict
  consumers, durable-record compatibility, and old-record parsing.
- Repeat the pattern and population sweeps.
- Check blast radius, bounded observability, changelog, commit, and PR-body
  requirements.
- For LSP, dispatch, cache, runner, or tool changes, test one non-TypeScript
  registry entry through the same seam.
- On a net-count fold, mutate every predicate the deleted sibling used to
  back; the fold's own tests were written when two guards existed (#3064 F1,
  #3065 F3, #3066 F3, #3068 F2).

## Review follow-ups

- Classify every finding as **fold** or **file**, with a one-word reason.
- Fold same-seam or same-file follow-ups that are about one commit and need no
  maintainer decision; contract-only items trail the PR without re-verification.
- Small code folds carry a red-first test and return to the same reviewer.
- File only for a different seam, another PR's blocker, a maintainer decision,
  untouched pre-existing work, or a changed risk class (for example lifecycle
  on a tooling PR); file one consolidated issue per PR for all residuals.

## Finding format

Order findings: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NITPICK`.

Each actionable finding contains:

1. Severity and stable id.
2. File/symbol anchor.
3. Reproduction command or probe output.
4. Expected and observed behavior.
5. Root cause, cost, and concrete remedy.
6. Issue-acceptance or repository-standard classification.

Severity requires a reproduced failure. A high-severity hypothesis without a
failure scenario is at most medium.

## Verdict

Start with one verdict: `merge as-is`, `merge after fixes`, or `redesign`.
Then include:

- `Could not verify`: every blocked or environment-limited check.
- `Named output`: structural insight not closed by the probes.
- `Generalization verdict`: the population, excluded defaults, and one of the
  three required verdicts above.
- `Disposition table`: each prior finding as `fixed`, `not fixed`, `new defect`,
  or `withdrawn (reason)`.
- Cleared categories and exact-head identity.

Use short, active, plain prose. Never merge, push, commit, or silently repair.
