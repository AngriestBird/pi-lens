# Cascade delivery model

A TLA+ model of what the cascade tells the agent about the import neighbours
of an edited file, turn after turn: the in-lane compute
(`clients/dispatch/integration.ts` `computeCascadeForFile`), the outstanding
silent-push touches (`clients/lsp/cascade-tier.ts`), and the turn_end render
with the pending error record (`clients/runtime-turn.ts` `handleTurnEnd`,
`clients/cascade-format.ts`). Every config states its expected verdict on its
first line, and the `TLA+ models` CI job (`node scripts/check-tla-models.mjs`)
checks them all.

Issues: #4485 (tier-3 neighbours deferred to a quiet window that mostly never
came, and runs that read clean with every neighbour unanswered), #4486
(snapshots and fallbacks from before the edit), #4487 (the rolling delta and
the recently-clean skip hiding a persistent error). #1712 is the live lane
over a real classic TypeScript server
(`tests/clients/cascade-classic-ts-live.test.ts`).

## What the model covers

One primary, two neighbours, one cascade run per turn, three turns. Each
neighbour's server follows one publish model, chosen at Init from `Models`:

| Model | Server | Publishes |
|---|---|---|
| `Pull` | pull diagnostics | answers a request at once |
| `CmdPull` | classic TypeScript (`typescript.tsserverRequest`) | on a change of verdict or a first open; answers the command at once |
| `Always` | pyright | after every notify |
| `Silent` | lua-language-server | on a change of verdict or a first open, so silence can mean clean |

Freshness is an epoch: `epoch` counts the primary's edits, and a cache entry
stamped with the current epoch was published after the edit the run is about.

| Action | What it abstracts | Source |
|---|---|---|
| `Edit` | the primary's write and notify; an open neighbour owes a publish per its model | `clients/runtime-tool-result.ts` (the dispatch), `clients/lsp/client.ts` (the notify) |
| `Publish(n)` | an owed publish lands in the client's per-file cache | `clients/lsp/client.ts` `getAllDiagnostics`, `getDiagnosticsVersionForPath` |
| `Compute` | the run: the recently-clean skip (mutant only), the passive snapshot, the touch per model and tier, the bounded in-lane wait, the degraded fallback, the delta (mutant only) | `integration.ts` `computeCascadeForFile`, `isPostEditObservation`, `SILENT_PUSH_WAIT_MS`, `appendFallbackNeighbors`; `cascade-tier.ts` `classifyCascadeWaitTier` (`command-pull`) |
| `LaterWrite` | a later write of the primary supersedes the run before turn_end | `runtime-turn.ts` consume filter (`cascade_carry_over_drop`) |
| `QuietWindow` | optional: the quiet window reconciles answered outstanding touches | `clients/quiet-window.ts`, `cascade-tier.ts` `reconcileOutstandingCascadeTouches` |
| `Expire(n)` | an outstanding touch ages out of the registry | `cascade-tier.ts` prune (`cascade_tier3_expired`, `deliverResolvedOutcome`) |
| `TurnEnd` | the registry peek, the run's section, the late answers, the unresolved line, the record update | `runtime-turn.ts` `handleTurnEnd` (`peekOutstandingCascadeTouches`, the pending and unresolved sections), `cascade-format.ts` `recordDeliveredCascadeNeighbor`, `forgetCascadePendingNeighbor` |

Out of scope, by design: two runs in one turn (turn_end's ownership pass gives
each neighbour to the last run that observed it; `cascade-turn-merge.test.ts`
covers it), a turn with no edit (a read-only turn renders no cascade section,
so no unresolved line either), the cap and its holds (`turn-end-delivery-holds`
models them), a primary with blockers (the cascade is skipped,
`skipReason: "blockers"`, by maintainer decision on #4485), commit gating
(neighbour errors stay advisory, same decision), and languages outside
`CASCADE_GRAPH_KINDS`.

## Invariants

- `NoCleanWithoutFreshObs`: a neighbour of a delivered run that the agent
  reads as clean (no error, no pending, no unresolved line) was observed clean
  after the edit.
- `NoErrWithoutFreshObs`: an error shown as this turn's was observed after
  the edit (an older answer renders as a labelled late one).
- `PersistentReserved`: an error the record held before turn_end, that no
  newer observation cleared, is shown again: as this turn's error, as a late
  answer, or on the unresolved line.
- `TouchEndsWithinBound`: every touch the run sent ends answered, or shown
  pending, in the same turn. The temporal form,
  `[](outstanding(n) => <>(answered(n) \/ pendingShown(n)))` under weak
  fairness on `TurnEnd`, is the same property; the model checks the bounded
  form as safety.
- `AnswerWhenAskable`: a neighbour whose server answers on request (`Pull`,
  `CmdPull`) is answered, never left outstanding.
- `ExpiryKeepsAnswer`: an answer that arrived for an outstanding touch is
  never dropped unread when the touch expires.
- `TypeOK`.

## Switches

The fix value first, then the as-built (pre-#4485) value.

| Switch | Fix | As built | Mutant config | Violates |
|---|---|---|---|---|
| `TierPath` | `"inLane"` | `"deferQuiet"` | `MutTierPath` | `AnswerWhenAskable` |
| `PassiveGate` | `"afterEdit"` | `"ttl"` | `MutPassiveGate` | `NoCleanWithoutFreshObs` |
| `FallbackGate` | `"afterEdit"` | `"ttl"` | `MutFallbackGate` | `NoErrWithoutFreshObs` |
| `RecentlyClean` | `FALSE` | `TRUE` | `MutRecentlyClean` | `NoCleanWithoutFreshObs` |
| `Delta` | `"none"` | `"rolling"` | `MutDelta` | `PersistentReserved` |
| `UnconfirmedMarker` | `"marked"` | `"none"` | `MutUnconfirmedMarker` | `TouchEndsWithinBound` |
| `ExpiryRead` | `"peekLog"` | `"drop"` | `MutExpiryRead` | `ExpiryKeepsAnswer` |
| `Reserve` | `"record"` | `"none"` | `MutReserve` | `PersistentReserved` |

`Merged` sets every switch to its fix value and passes. `AsBuilt` sets every
switch to its as-built value; TLC's first counterexample is a stale clean
snapshot served for the edit (`NoCleanWithoutFreshObs`). Each mutant config
flips one switch and checks `TypeOK` with the invariant it breaks. Every
switch is pinned in `formal/switch-pins.json` to the test that drives the real
code.

## Running

```
node scripts/check-tla-models.mjs
```
