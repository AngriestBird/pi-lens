# Fixer contract

## Mission

- Read the issue, `AGENTS.md`, `docs/pi-lens-subagent.md`, and this contract.
- Trace the production entry point before naming a seam.
- Reproduce the defect on the current tree.
- Before writing the fix, or a unit tested in isolation, list the ways it can
  fail (inputs, states, orderings, platforms) in the PR body; a space with two
  axes is a table. The tests cover that list, not only the happy path.
- Implement the smallest root-caused fix.
- Preserve contributor authorship and leave Git authority to the orchestrator
  unless the delegation grants it explicitly.

## Standing procedure

### Standard mechanics

- Commit the code as soon as the targeted suite is green, then add evidence in
  a later commit. A worker can be settled mid-evidence-pass; on PR #3268 the
  orchestrator had to commit the tree.
- A whole-module `vi.mock` of a production module must spread `importOriginal`.
  Run `tests/config/vi-mock-export-sweep.test.ts`.
- Exact-pin sweeps and merge state: `tests/config/glossary-synonym-sweep.test.ts`
  (#3279) pins the live retired-synonym identifier population per (term, file)
  exactly, in both directions. If a change adds or removes one of the pinned
  identifier uses, run the sweep on the head and on the merge of
  `origin/master` + head before pushing, then re-pin in the same PR using the
  sweep's own `UNPINNED`/`STALE` output. On 2026-09-23, two green PRs merged
  red (#3279's pins predated #3283, leaving master red until #3288), and #3284
  was red on its own `path` count changes (cue-vet 5→6, dart-analyze 6→4)
  until an orchestrator trailing commit re-pinned.

- Put each core-domain rule in its owning module; every caller asks that owner.
  Re-deriving an owned rule at a consumer is wrong; extend the owner, or create
  a new one only with a stated reason, in its domain owner (#3781, #3794, #3796).
- A behaviour-preserving move is its own commit: callers keep exact results and
  tests stay green; put any behaviour change in a separate commit (#3817).

### Failure list before code

Before the first edit of any fix, write the list of ways the change could fail
(the directions the mutation table will later prove) in the PR body. The
mutation table is that list with transcripts, never a list invented after the
code. This week's evidence: #3252 r1 shipped an exit table whose inverse
direction (nonzero WITH findings) was never listed and was caught by the
reviewer.

For a change that targets a subset of a larger population, the failure list
also names the population M, the excluded M−N set's default, and the planned
generalization verdict: *widen in this PR* / *follow-up issue* with its seam
group / *stay specific* with the reason. Recurrence: #3622.

When a gate becomes fail-closed, sweep every construction site that reaches it,
including test doubles, and prove the sweep with the behaviour suites (#3622).

Run `git check-ignore -v` on every new artifact path before citing it (#3648;
the linter half landed in #3464).

A measured constant names its measuring command and keeps raw output as a
tracked artifact pinned by a test (#3648 M3648-3).

Seams are named in the brief before the round; no test is written at an
unconfirmed seam — a fixer that needs a new seam stops and reports it as a
finding, not as a test.

A fix round does not deepen: no refactor, no helper extraction, no rename
beyond the fix's own lines; deepening is its own slice under the owning
umbrella. #3254 and #3256 stayed inside their briefs; #3178's four rounds show
the cost of not doing so.

### Lifecycle, timing, and identity seams

A change on a lifecycle, timing, or identity seam extends or adds a TLA+ model
in this step (#3802). Find the family the changed files map to in
`formal/coverage-map.json`, write the invariant the change preserves or
tightens, and show the violating config red on the pre-fix model and green
after. When the change genuinely does not move the model, carry a
`TLA+ unaffected: <family> — <reason>` line in the PR body instead of leaving
the obligation silent. A row is any-of: a `.tla`/`.cfg` change under, or a
declaration for, any one of the row's families satisfies it. The `unmodelled`
rows mark known gaps, and a row of 4+ families (a hub file) only prints a note
until hunk-level matching exists (#3878); neither excuses a change that moves
the behaviour.

The map owner is the lane that adds the family: a TLA lane that adds a
`formal/<family>/` directory adds it to `families` and adds (or extends) the
map row naming it in `formal/coverage-map.json` in the same PR.
`validateCoverageMap` reds the Unit tests lane on a `formal/<dir>` the map
does not list.

### Review follow-ups

- Apply folded follow-ups in the same PR when they share the seam or files, are
  about one commit, and need no separate maintainer decision.
- Contract-only folds (body, comments, wording) are trailing commits with no
  re-verification; small code folds carry a red-first test and return to the
  same reviewer.
- File only different-seam, blocked, decision-dependent, untouched pre-existing,
  or risk-class-changing residuals; list all filed residuals in one **Residuals**
  section of the PR body, consolidated as one issue per PR.

## Evidence

- Witness rule (ADR 0007): #1605 owns the witness lanes, and their fixtures
  live under `tests/fixtures/witness/<slice>/`.

- Add a regression test through the production path.
- Capture the pre-fix assertion failure for every new test (red-first stays
  mandatory).
- Prove the fixed test passes.
- Hand-mutate only the NEW guard, branch, filter or cap the PR is about, one
  row per direction, and quote the compile-valid red. Stryker samples at most 6
  files and cannot give the red-first proof, so it does not replace this.
- After the push, read the `Mutation diff` comment for your exact head (its
  `Head:` line must match; `node scripts/ci-verdict.mjs <pr>` prints a
  `MUTATION` line). Kill every survivor on a line you added with a test in the
  PR, or show it equivalent with a reason in the PR body.
- Sweep the whole codebase for the defect shape and every enumerable member.
- Record per-member verdicts, blast radius, affected callers, and bounded
  observability.

## Required checks

- Run `npm run build` before tests and rebuild between mutations.
- Run targeted tests through the repository's pinned environment. Include every
  test that mocks or deep-equals a changed module or record.
- Add `tests/config/` and spawn-heavy lanes for real child or LSP tests.
- Reproduce CI-only failures in the CI command shape.
- Use the exact npm pin in `package.json` for lockfile changes.
- Add one `.changelog/<slug>.md` fragment for code changes. Never edit
  `CHANGELOG.md`.
- Run release-QA end to end when a release-QA row changes.

## Test screens

- Enter through the real production function.
- Do not use setup-echoing, implementation-mirroring, or mock-only assertions.
- Do not use ambient stack/caller inspection in doubles.
- Restore env, timers, cwd, and module state.
- Make skips explicit and visible.
- Use independent expected values and behavioral assertions.
- Keep timing bounds near measured fixed and regressed values.
- Make every PR-body test id grepable in the tree.

## Handoff

- Without Git authority, leave changes uncommitted.
- Write root-level `PR_BODY.md` and `COMMIT_MSG.txt`; keep both untracked.
- The PR body is the whole `.github/PULL_REQUEST_TEMPLATE.md`, every
  heading present in order: `## Why` (one sentence), `## Notes for the
  reviewer`, `## Change outline`, `## Summary`, `## Type of change`,
  `## Area`, `## Checklist`, `## Tests`, `## Blast radius`,
  `## Observability` (a record literal from the runtime diff, or exactly
  `No new failure path; no record added.`), `## Class sweep`, and
  `## Test assessment`. A brief that names only some headings does not
  shorten this list.
- Run `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` and
  `node scripts/check-changelog-fragments.mjs` before the hand-back; both
  must pass, and the hand-back quotes them. A changelog fragment is
  `---` / `section: <Added|Changed|Deprecated|Removed|Fixed|Security>` /
  `---` / blank / one `- ` bullet. (Four of six Luna PRs on 2026-09-23
  redded the PR-body and changelog gates on the first head; the fixes were
  all mechanical.)
- Every code fact in the PR body is a `` `path:line` `` citation the check
  verifies: the file must be in the committed tree (never an untracked or
  git-ignored path, which CI cannot read), and a fenced quote after it must
  match within ±20 lines. Prose about code with no citation is unverified.
- The hand-back carries the commit SHA; a dirty tree is an incomplete
  round.
- Include every red, mutation result, skipped check, and environment block.
- Answer each finding id with `fixed`, `not fixed`, or `withdrawn (reason)`.
- Report verdict, changed files, totals, and unverifiable checks.
