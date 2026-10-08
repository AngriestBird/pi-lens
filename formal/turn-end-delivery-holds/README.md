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
| peek-then-commit | 1 | dependency-drift count, `skipOnSuppressed` | `runtime-turn.ts:1574-1575` |
| peek-then-commit | 6 | past-EOF retirement (secondary's), settles delivered even when suppressed | `runtime-turn.ts:1567-1570` |
| drain-then-restore, bounded | 2 | late auxiliary pair, `canHold` = `canRearmPendingAuxiliary` (#3900) | `runtime-turn.ts:5073-5090`, `pending-aux-coverage.ts:205-214` |
| drain-then-restore, unbounded | 3 | settled runner result requeued (#3813); cascade run re-appended | `runtime-turn.ts:1302, 1376, 1877, 2040` |
| park-then-recheck | 4, 5 | cut-advisory park of the primary (4) and of a concurrent secondary (5) (#4112, #3901) | `runtime-turn.ts:1211-1244`, `runtime-coordinator.ts:1479-1491` |

Actions, one per step of `handleTurnEnd`, per session `s`:

- `NextTurn(s)`: the park lane's next successful run takes the entries under
  its key and keeps the ones it still reports (`takeCutAdvisoryItems`,
  `stillReportedParked`: `runtime-turn.ts:2257-2258, 2280`,
  `delivery-holds.ts:157-165`). A failed run leaves them parked, so the action
  is optional.
- `Compose(s)`: the producers push their parts in any order and size. A peek
  producer leaves its state alone; a drain or park producer consumes it. Every
  taken re-offer must appear in the message.
- `Cap(s)`: `planDeliveryHolds` and `capTurnEndMessage`. A part is reached when
  it lies whole inside the kept prefix, or leads the message and so could not
  fit alone (`delivery-holds.ts:100-111`). `keeps` asks `canHold` once, before
  the message is final (`delivery-holds.ts:110`). The signature-dedupe verdict
  (`runtime-turn.ts:5329-5376`) is a free choice.
- `Settle(s)`: each hold runs once, guarded by `isCurrentSession`
  (`delivery-holds.ts:120-146`, `runtime-turn.ts:5291-5294`). Reached parts
  commit (`onDelivered`, skipped on a suppressed turn for `skipOnSuppressed`);
  cut parts restore (`onHeld`) or are dropped with a record (`onDropped`).
- `SessionReplace`: `resetForSession` clears the session-scoped stores
  (`runtime-coordinator.ts:652-667`). It is disabled between `Cap` and
  `Settle`, which are one synchronous block in the code
  (`runtime-turn.ts:5285-5386`).

The park map is the item status itself (`parked` under a lane key), so a park
that replaces its lane's entry (`runtime-coordinator.ts:1479-1481`) is an
`evicted` status.

## Invariants

| Invariant | Statement |
|---|---|
| `NoLossByCap` | A part the cap cut is still pending after `Settle` (queued, peek-pending, or parked), unless it was dropped with a recorded reason. A re-armed pair the next drain retires undelivered, and a park the lane replaced, are losses. |
| `NoDoubleDelivery` | An item reaches the agent at most once per generation, and a parked item is re-offered only while its lane still reports it. |
| `NoPin` | A re-offered item is never parked again (`delivery-holds.ts:25-26`), and a leading part is never held (`delivery-holds.ts:28-33`). |
| `HoldFencedToSession` | A turn composes only its own session's items, and no store entry carries a replaced session's generation. |

## Configs

| Config | Expect | What it proves | States (generated / distinct) |
|---|---|---|---|
| `Merged` | pass | Merged master. | 10,775,304 / 3,498,080 |
| `PreCapCommit` | violated `NoLossByCap` | The producer commits at compose, before the cap (the shape #3813 removed): a cut peek part is gone. 4-state trace. | 15,741 / 9,281 |
| `NoCanHold` | violated `NoLossByCap` | The late auxiliary hold without `canHold`: `rearmPendingAuxiliaryCoverage` re-arms past its bound (`pending-aux-coverage.ts:302`), the next drain retires the pair, and `onDropped` never fires. 7-state trace. | 581,465 / 271,073 |
| `ReOfferUnbounded` | violated `NoPin` | A part showing only re-offers can be held (`canHold` always true): a cut re-offer is parked a second time. 8-state trace. | 1,367,057 / 615,411 |
| `ParkNoSessionKey` | violated `HoldFencedToSession` | The pre-round-2 park key of #4112: the secondary's lane run takes the primary's parked item and its message shows it. 6-state trace. | 236,662 / 126,719 |
| `MutNoLeadReach` | violated `NoPin` | Drop the `leadsOversized` clause (`delivery-holds.ts:105-106`): a leading oversize part is held. | 13,841 / 7,865 |
| `MutNoLiveFence` | violated `HoldFencedToSession` | Remove the `isCurrentSession` guard (`delivery-holds.ts:125, 130`): a restore after a session replacement writes the old generation into the new session. | 74,857 / 43,190 |
| `MutUncheckedRecheck` | violated `NoDoubleDelivery` | `stillReportedParked` returns every parked item: a fixed item is announced again. | 236,294 / 126,413 |
| `MutRestoreReached` | violated `NoDoubleDelivery` | `onHeld` also runs for a reached drain part: the delivered state returns and reaches the agent twice. | 548,267 / 256,304 |

State counts for the violated configs are TLC's counts at the violation (one
worker, breadth-first, so deterministic). TLC 2.19, `-workers 1`.

The mutation proof for `Merged` (neutering a spec action, not a config
switch): replacing the drain restore with a no-op (`"msg"` for the restored
status in `PartSt`) and, separately, the park with a no-op flips `Merged` to
`violated NoLossByCap` (8,389 and 8,983 distinct states).

## What the model cannot see

- **One size axis.** `capTurnEndMessage` cuts on lines and on chars
  (`runtime-turn.ts:833-860`); the model has one budget. The reach rule is
  per part and does not read the axis.
- **One item per part.** A part that mixes re-offers and new items parks only
  the new ones and records the rest (`runtime-turn.ts:1226-1240`); the model
  has the all-new and all-re-offer cases, which are the cells the invariants
  are about. A part with no hold, and two holds on one part text
  (`delivery-holds.ts:86-91`), are not modelled.
- **Time.** The late auxiliary TTL is the `RearmMax` bound on restores
  (`pending-aux-coverage.ts:192-214`).
- **The lane bound.** `MAX_CUT_ADVISORY_LANES` (16) evicts the oldest parked
  lane with a record (`runtime-coordinator.ts:52`); the model has two lanes.
- **The drain-shape stores are not session-keyed.** The runner store and the
  cascade runs are fenced by the live generation only, so a concurrent
  secondary's turn end can drain a live primary's entries (the R2 remainder of
  #4118; #3613, #3758 open). Only the park map carries the turn's session id.
  Modelled by lane M4 (`session-lifecycle`), not here.
- **The late scan family.** `runtime-turn.ts:539-700` is lane M2.

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
  and "a new session does not inherit a parked item" (`ParkKey`, `Fence`).
