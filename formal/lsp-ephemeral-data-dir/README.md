# Ephemeral LSP data directory model (#3803, M7)

This model covers the merged #4127 implementation in `clients/file-utils.ts`
and `clients/runtime-session.ts`: temporary checkout roots are classified and
memoized, one random token is settled per process, and `session_start` removes
only entries whose pid is dead. The process token is modeled as a unique
per-process serial; the random suffix is not otherwise observable.

## Invariants

- `NoSharedEphemeralDir`: a live process never selects an ephemeral
  data-directory identity still held by another process, including a dead
  process's leftover after pid reuse; this implies two live processes never
  share one.
- `SweepOnlyDead`: a sweep never removes a directory owned by a live process.

## Configs

`PreFixShared` is the old pid-only naming rule and violates
`NoSharedEphemeralDir` after pid reuse. `PreFixSweep` is the unsafe cleanup
shape and violates `SweepOnlyDead`. `Merged` enables the process token and the
dead-pid guard and passes both invariants. The `memo` variable represents the
classification memo: a root's policy is settled once and is not changed by a
later classification.

Run with `node scripts/check-tla-models.mjs`; the repository checker includes
every config under `formal/`.
