# Blocker pending model

A TLA+ model of one file F and its inline-blocker record over a session. It
covers which blockers F's bytes hold, what each post-write dispatch observes,
and what the delta calls new. From those, it says what the record, the tool
result, the commit gate and the turn-end Resolved line report. Every config
states its expected verdict on its first line. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #4484.

The seam:

- The delta split is `filterDelta(..., d => d.id)` in
  `clients/dispatch/dispatcher.ts`. Its held-back blocking set is
  `DispatchResult.heldBackBlockers`.
- The pipeline's record, clean text and stored diagnostics are in
  `clients/pipeline.ts` (`recordBlockers`, `stillUnfixed`, `storedDiagnostics`).
- The record verb is `recordInlineBlockers` or `clearInlineBlockers`, called
  from `clients/runtime-tool-result.ts`.
- The clear refusal is in `clearInlineBlockers` in
  `clients/runtime-coordinator.ts` (`analysis.blocking`).

## What the model covers

- **Findings.** `"a"` and `"b"` are blockers that a fast (inline) runner
  reports. `"d"` is a blocker that a collect-later runner reports (`Deferred`).
- **Ids.** A finding's id is the one the delta keys on.
  - A line-bound id is `<<finding, line offset>>`. LSP ids work this way
    (`lsp:<code>:<line>`, `clients/dispatch/utils/lsp-diagnostics.ts`). A line
    inserted above the finding gives it a new id.
  - An ordinal id (`Ordinal`) is the finding's rank in the observation.
    helm-lint ids work this way (`helm-lint-<ordinal>-<level>`,
    `clients/dispatch/runners/helm-lint.ts`). Fixing an earlier finding
    renumbers the later one onto the fixed one's id.
- **Actions.** Each action maps to one row of the hook flow:

  | Action | Code step |
  |---|---|
  | `WriteStep` | An authored write or edit and its `tool_result` pipeline, run up to the record verb. `new` is the blocker set of the new bytes. `shift` inserts a line above every finding. `touched` is the findings on changed lines (`ctx.modifiedRanges`). |
  | `OpaqueStep` | An unauthored write (an opaque bash recovery, #3226) that introduces nothing. Its run withholds the blocker channel, so it can only keep or clear the record. |
  | `SettleStep` | The collect-later run of the current bytes settles, and its blocker joins the record (`recordDeferredInlineBlockers`). This happens at the commit gate or in the turn end's late lane, whichever asks first. |
  | `TurnEndStep` | `handleTurnEnd`. The late lane may or may not find the deferred run settled. The replay lists the record as unresolved. The Resolved line names F when a clear noted it and nothing is still unresolved. The record carries into the next turn. |

  Writes are sequential. How the record verb is ordered under parallel writes
  is `dispatch-pipeline`'s model (`InlineFix`, the write-order token).
- **Switches.**
  - `ClearOnCurrent` (the #4484 fix, pinned TRUE): the record, the clean text
    and the clear read the current blocking set. That is the observation's
    blockers, whether or not the delta calls them new. FALSE is the code before
    #4484: they read only the delta's blockers, so an empty delta clears the
    record.
  - `OpaqueKeep` (the #4484 fix, part 2, pinned TRUE): an unauthored run clears
    the record only when it observes no blocker. FALSE is the code before
    #4484: it cleared on any new bytes.
  - `Delta`: FALSE is `--no-delta`, the causal differential.
  - `RangeGated`: finding `"a"` comes from a runner that drops blocking matches
    on lines the write did not change. tree-sitter does this today
    (`blockingOnly`). After #4482, the ast-grep runners do too.

## Invariants

- `GateHonest`: the commit gate is open, meaning there is no record, only when
  no completed observation of the current bytes holds a blocker.
- `CleanHonest`: a write's tool result says clean only when its observation
  holds no blocker.
- `ResolvedHonest`: F is reported resolved only when every blocker in the
  cleared record was observed gone. A fast blocker must be absent from the
  bytes the clearing write's runners saw. A deferred blocker must be absent from
  a settled run of the current bytes.
- `GateSound`: the gate is open only when the bytes hold no fast blocker. This
  is stronger than `GateHonest`, because it also catches a blocker that no
  runner observes.

## Configs

States are as TLC reported them with `-workers 1` (generated / distinct).

| Config | Expect | States | What it proves |
|---|---|---|---|
| `MutDeltaClear` | violated `GateHonest` | 53 / 21 | The code before #4484 (the issue's trace, below). Write 1 introduces E, the agent ignores it, and write 2 leaves E in place. The empty delta clears the record and the gate opens. |
| `MutDeltaClean` | violated `CleanHonest` | 53 / 21 | The same trace: write 2's tool result says clean while its observation holds E. |
| `MutDeltaResolved` | violated `ResolvedHonest` | 207 / 55 | The same trace, then a turn end that reports F resolved. |
| `MutDeltaClearOrdinal` | violated `GateHonest` | 20 / 10 | Ordinal ids are red too. The renumbering case (write {a, b}, then write {b}: b takes ordinal 1, which the baseline holds) is a trace of the same length. |
| `MutOpaqueClear` | violated `GateHonest` | 14 / 9 | The fix without part 2. An unauthored run of changed bytes that still holds E clears the record. |
| `ClearOnCurrent` | pass | 5232 / 654 | The fix, line-bound ids. It covers three writes, an unauthored write, two turn ends and a line shift. Every invariant holds, `GateSound` included. |
| `ClearOnCurrentOrdinal` | pass | 5232 / 654 | The fix, ordinal ids. Renumbering never clears a blocker that the observation still holds. |
| `NoDelta` | pass | 1328 / 183 | The causal differential. The code before #4484 under `--no-delta` is honest, so the defect needs the delta. |
| `DeferredGateHonest` | pass | 33231 / 4350 | The fix with a collect-later blocker. Whatever the deferred run's timing, the gate and the tool result stay honest. `GateHonest` counts a settled run only. That is the #3814 design: the commit gate absorbs a settled answer first (`absorbSettledRunnerBlockers`), and a run in flight does not gate. |
| `DeferredInFlight` | violated `ResolvedHonest` | 731 / 114 | A residual that TLC found, not fixed here (see below). |
| `RangeGatedResidual` | violated `GateSound` | 20 / 10 | A residual of the same shape, not fixed here (see below). |

The `MutDeltaClear` trace is write, ignore, write:

```
State 1: Init                 disk = {}     rec = {}     toolClean = TRUE
State 2: WriteStep            disk = {"a"}  rec = {"a"}  toolClean = FALSE   base = {<<"a", 0>>}
State 3: WriteStep            disk = {"a"}  obsF = {"a"}  rec = {}  toolClean = TRUE  noted = TRUE
```

## Counter-checks

Each switch has a config that flips when it is turned:

- `ClearOnCurrent`: `ClearOnCurrent` to `MutDeltaClear` (that config has no
  unauthored write, so `OpaqueKeep` is inert there).
- `OpaqueKeep`: `ClearOnCurrent` to `MutOpaqueClear`.
- `Delta`: `MutDeltaClear` to `NoDelta`.
- `Ordinal`: `ClearOnCurrent` to `ClearOnCurrentOrdinal` (both pass: the fix
  does not read the id), and `MutDeltaClear` to `MutDeltaClearOrdinal` (both
  red).
- `Deferred`: `ClearOnCurrent` to `DeferredInFlight`.
- `RangeGated`: `ClearOnCurrent` to `RangeGatedResidual`.

## Residuals TLC shows

- **Deferred in flight (`DeferredInFlight`).** A collect-later blocker d joined
  the record. A later write's fast runners observe nothing, so the record
  clears while d's re-check is in flight (the #3814 design). A turn end whose
  late lane does not find that run settled then reports F resolved, but d was
  never observed gone. The gate stays honest (`DeferredGateHonest` passes). A runner that changes tier between writes reaches the same
  state.
- **Range-gated runners (`RangeGatedResidual`).** A runner that reports
  blockers only on changed lines does not observe E after an unrelated write.
  The current set is then empty, the record clears, and the gate opens while E
  is still in the bytes. This was true before #4484 for tree-sitter.

## What the model cannot see

- Parallel writes and the write-order token (`dispatch-pipeline`'s `InlineFix`).
- Neighbour-file cascade baselines (`applyCascadeDeltaBaselines` in
  `clients/dispatch/integration.ts`). That is another file's record, a separate
  seam.
- Delta-promoted unused values (`promoteDeltaUnusedToBlockers`). Such a value
  blocks only while it is new, so the model does not include it. The witness
  does not cover it either.
- A runner that fails or times out. Its missing result looks like an empty
  observation.

## Replay on the real code

`tests/index-4484-unfixed-blocker-witness.test.ts` drives the real extension
handlers (`tool_call`, `tool_result`, `turn_end`, the git guard). The LSP
service and the process spawn are doubled at their host boundary. Its cells:

- A: an LSP error that write 2 left in place, on every surface.
- C: a write that removes the error.
- B: an error moved by a line shift.
- I: the cross-turn case.
- K: the `--no-delta` differential.
- F and H: helm, before and after a line shift.
- R: helm renumbering.

`tests/clients/opaque-mutation-scan.test.ts` covers part 2 ("keeps an authored
blocker when an opaque run of changed bytes still observes it (#4484)").
