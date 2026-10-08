# Turn-end delivery holds model

A TLA+ model of the turn-end composer's delivery holds
(`clients/turn-end/delivery-holds.ts`, wired in `clients/runtime-turn.ts`
`handleTurnEnd`). A producer that consumes one-shot state for a part cannot
know at compose time whether `capTurnEndMessage` will cut the part, so it
registers a hold; the composer judges every hold once against what the cap
kept and runs one callback per hold. Every config states its expected verdict
on its first line, and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3803 (model lane M1), #3813 (the holds and their chain of rounds),
#3900 (late auxiliary re-arm), #3901 and #4112 (the park-then-recheck carry
and its session key). #3999 and #3808 only reshape the parts a runner hold
names; they add no hold shape.

## What the model covers

Six items, one part each, over three hold shapes. Each row cites the source
the action abstracts.

| Shape | Item | Producer | Source |
|---|---|---|---|
| peek-then-commit | 1 | dependency-drift count, `skipOnSuppressed` | `runtime-turn.ts` `countDriftDeliveryOnDelivery` |
| peek-then-commit | 6 | past-EOF retirement (secondary's), settles delivered even when suppressed | `runtime-turn.ts` `retirePastEofOnDelivery` |
| drain-then-restore, bounded | 2 | late auxiliary pair, `canHold` = `canRearmPendingAuxiliary` (#3900) | `runtime-turn.ts` (the late auxiliary hold), `clients/lsp/pending-aux-coverage.ts` `canRearmPendingAuxiliary` |
| drain-then-restore, unbounded | 3 | settled runner result requeued (#3813); cascade run re-appended | `runtime-turn.ts` (the runner and cascade holds) |
| park-then-recheck | 4, 5 | cut-advisory park of the primary (4) and of a concurrent secondary (5) (#4112, #3901) | `runtime-turn.ts` `cutAdvisoryHold`, `runtime-coordinator.ts` `parkCutAdvisoryItems`, `takeCutAdvisoryItems` |

Actions, one per step of `handleTurnEnd`, per session `s`:

- `NextTurn(s)`: the park lane's next successful run takes the entries under
  its key and keeps the ones it still reports (`takeCutAdvisoryItems`,
  `stillReportedParked` in `delivery-holds.ts`). A failed run leaves them
  parked, so the action is optional.
- `Compose(s)`: the producers push their parts in any order and size. A peek
  producer leaves its state alone; a drain or park producer consumes it. Every
  taken re-offer must appear in the message.
- `Cap(s)`: `planDeliveryHolds` and `capTurnEndMessage`. A part is reached when
  it lies whole inside the kept prefix, or leads the message and so could not
  fit alone (`delivery-holds.ts` `planDeliveryHolds`). `keeps` asks `canHold` once, before
  the message is final (`delivery-holds.ts` `planDeliveryHolds` (`keeps`)). The signature-dedupe verdict
  (the duplicate-findings suppression in `runtime-turn.ts`) is a free choice.
- `Settle(s)`: each hold runs once, guarded by `isCurrentSession`
  (`delivery-holds.ts` `settle`, `runtime-turn.ts` `settleHolds`). Reached parts
  commit (`onDelivered`, skipped on a suppressed turn for `skipOnSuppressed`);
  cut parts restore (`onHeld`) or are dropped with a record (`onDropped`).
- `SessionReplace`: `resetForSession` clears the session-scoped stores
  (`runtime-coordinator.ts` `resetForSession`). It is disabled between `Cap` and
  `Settle`, which are one synchronous block in the code, so no other action
  runs between them
  (`planDeliveryHolds` to `settleHolds` in `runtime-turn.ts` `handleTurnEnd`).

The park map is the item status itself (`parked` under a lane key), so a park
that replaces its lane's entry (`runtime-coordinator.ts` `parkCutAdvisoryItems`) is an
`evicted` status.

## Invariants

| Invariant | Statement |
|---|---|
| `NoLossByCap` | A part the cap cut is still pending after `Settle` (queued, peek-pending, or parked), unless it was dropped with a recorded reason. A re-armed pair the next drain retires undelivered, and a park the lane replaced, are losses. |
| `NoDoubleDelivery` | An item reaches the agent at most once per generation, and a parked item is re-offered only while its lane still reports it. |
| `NoPin` | A re-offered item is never parked again (the park-then-recheck note in `delivery-holds.ts`'s module header), and a leading part is never held (the reach rule in `delivery-holds.ts`'s module header). |
| `HoldFencedToSession` | A turn composes only its own session's items, no store entry carries a replaced session's generation, and a replaced session's `Settle` changes no store entry (delivered or held branch). |

## Configs

| Config | Expect | What it proves | States (generated / distinct) |
|---|---|---|---|
| `Merged` | pass | Merged master. | 4,845,576 / 2,402,000 |
| `PreCapCommit` | violated `NoLossByCap` | The producer commits at compose, before the cap (the shape #3813 removed): a cut peek part is gone. 4-state trace. | 15,261 / 9,281 |
| `NoCanHold` | violated `NoLossByCap` | The late auxiliary hold without `canHold`: `rearmPendingAuxiliaryCoverage` re-arms past its bound (`clients/lsp/pending-aux-coverage.ts` `rearmPendingAuxiliaryCoverage`), the next drain retires the pair, and `onDropped` never fires. 7-state trace. | 338,825 / 211,553 |
| `ReOfferUnbounded` | violated `NoPin` | A part showing only re-offers can be held (`canHold` always true): a cut re-offer is parked a second time. 8-state trace. | 770,569 / 501,619 |
| `ParkNoSessionKey` | violated `HoldFencedToSession` | The pre-round-2 park key of #4112: the secondary's lane run takes the primary's parked item and its message shows it. 6-state trace. | 148,630 / 101,327 |
| `MutNoLeadReach` | violated `NoPin` | Drop the `leadsOversized` clause (`delivery-holds.ts` `planDeliveryHolds` (`leadsOversized`)): a leading oversize part is held. | 13,817 / 7,865 |
| `MutNoLiveFenceDelivered` | violated `HoldFencedToSession` | The skip guards the held branch only, so `onDelivered` (retire past-EOF, bump the drift count) still runs after a replacement and writes the new session's store (`crossWrite`). The recurrence: `settle` has one `if (!live) continue` for both branches and a refactor could split them. 5-state trace. | 48,023 / 41,091 |
| `MutNoLiveFenceHeld` | violated `HoldFencedToSession` | The skip guards the delivered branch only, so `onHeld` still restores after a replacement with the old generation (`igen`). 5-state trace. | 50,089 / 42,799 |
| `MutUncheckedRecheck` | violated `NoDoubleDelivery` | `stillReportedParked` returns every parked item: a fixed item is announced again. | 148,262 / 101,021 |
| `MutRestoreReached` | violated `NoDoubleDelivery` | `onHeld` also runs for a reached drain part: the delivered state returns and reaches the agent twice. | 329,675 / 196,784 |

State counts for the violated configs are TLC's counts at the violation (one
worker, breadth-first, so deterministic). TLC 2.19, `-workers 1`.

`Merged` took 112 s locally with the first model and 246.6 s on the CI runner
(shard 1 went from 2m26s to 7m05s against the 12-minute job cap). Allowing only
`Settle` while a session sits between `Cap` and `Settle` (as the code is) cut
it to 2,402,000 distinct states, 64 s locally, with the same verdict.

The mutation proof for `Merged` (neutering a spec action, not a config
switch): replacing the drain restore with a no-op (`"msg"` for the restored
status in `PartSt`) and, separately, the park with a no-op flips `Merged` to
`violated NoLossByCap`. Removing `~crossWrite` from `HoldFencedToSession` makes
`MutNoLiveFenceDelivered` pass (2,873,235 distinct states), so the checker reds
it.

## What the model cannot see

- **One size axis.** `capTurnEndMessage` cuts on lines and on chars
  (`runtime-turn.ts` `capTurnEndMessage`); the model has one budget. The reach rule is
  per part and does not read the axis.
- **One item per part.** A part that mixes re-offers and new items parks only
  the new ones and records the rest (`runtime-turn.ts` `cutAdvisoryHold`); the model
  has the all-new and all-re-offer cases, which are the cells the invariants
  are about. A part with no hold, and two holds on one part text
  (`delivery-holds.ts` `planDeliveryHolds` `byPart`), are not modelled.
- **Time.** The late auxiliary TTL is the `RearmMax` bound on restores
  (`clients/lsp/pending-aux-coverage.ts` `isPendingAuxiliaryPastRearmTtl`).
- **The lane bound.** `MAX_CUT_ADVISORY_LANES` (16) evicts the oldest parked
  lane with a record (`runtime-coordinator.ts` `MAX_CUT_ADVISORY_LANES`); the model has two lanes.
- **The generation is captured at `Compose`, not at entry (#4161).**
  `handleTurnEnd` takes `holdGeneration` on entry and drains its producers
  after several awaits (the runner store, the cascade settle, the consume of
  the cascade runs). A session replaced inside that window lets the old turn
  drain the new session's state, and its `settle` is skipped, so a cut part is
  never restored. The model captures and drains in one `Compose` step, so this
  window is not reachable in it. A real code defect, filed as #4161; it needs
  a capture-timing action, which is lane M4's family (`session-lifecycle`).
- **The producers' stores are process-wide, not session-keyed.** The runner
  store and the cascade runs are fenced by the live generation only, and the
  peek shape's store (`_pendingInlineBlockers`, read through
  `getInlineBlockersSnapshot`) has no session field, so a concurrent
  secondary's turn end can drain or compose a live primary's entries (the R2
  remainder of #4118; #3613, #3758 open). Only the park map carries the
  turn's session id. The model assigns each peek item an owner
  (`Owner`), a modelling choice that makes the first clause of
  `HoldFencedToSession` true by construction for items 1 to 3 and 6. Lane M4
  (`session-lifecycle`) owns these stores.
- **The late scan family.** `runtime-turn.ts` `LateDeadCodeScan` is lane M2.

## Replay on the real code

The tests that pin the same cells through the real `handleTurnEnd`:

- `tests/clients/turn-end-cap-consumed-state.test.ts`: "retires a record whose
  advisory cannot fit the cap even alone (no starvation)" and the F2 group
  (`Lead`, `NoPin`); "does not hand a cut run back to a session that replaced
  the one it came from" (`Fence`); "does not re-arm a cut pair that is past
  its re-arm TTL" and "a pair cut on every turn stops re-arming at the ceiling
  and records the drop" (`DrainAsk`); "a dedupe-suppressed identical turn still
  consumes a fitting result" (the suppressed branch); the M1-M3 `CELLS` groups
  (`PeekCommit`).
- `tests/clients/turn-end-cap-edit-derived.test.ts`: "does not re-offer a cut
  item the next scan no longer reports" (`Recheck`); "bounds the carry: an item
  cut on two consecutive turns is dropped with one record" (`ReOffer`); "a
  same-root secondary turn neither takes nor shows the primary's parked item"
  and "a new session does not inherit a parked item" (`ParkKey`, `Fence).
