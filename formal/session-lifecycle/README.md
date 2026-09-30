# Session lifecycle model

A TLA+ model of pi-lens' session-scoped stores across every pi session
transition. It is slice S9 of the #3609 design (one session-scoped state
store) and the composition layer over the sibling models: content-level truth
stays in `formal/read-guard`, `formal/session-straddle`, `formal/format-drain`
and `formal/session-registry`. Every config states its expected verdict on its
first line (see `formal/file-locks/README.md`), and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

The pass configs model the adopted design: D1-D8, plus the maintainer's
2026-09-30 decisions on this model's findings F1 and F2 (posted on #3609).
The `AcceptedLateRead*` configs pin the false block that the design accepts
(F1). Each `Mut*` config removes one mechanism or restores one table row, and
must violate. Some of them model today's code or code before a fix that has
landed; the others model a design alternative that the adopted design
rejects. The "Mut configs" table says which. `Current` models master.

## What the model covers

**Store content is abstracted to facts.** A fact `[e, o]` says "scope `o`
recorded something about the tool result at conversation entry `e`". The read
guard (`RG`) is the fact store. `RG` conflates read records and authorship
(`recordWritten`). The two differ on `/tree`, where today authorship is reset
(#3603, not separated here), and in how today's writers reach the guard (see
`read` below). Beside it:

- the turn counter (`TC`);
- the widget's write-order guard (`WG`), which lives in a `clients/` module
  and so survives an entry-module re-evaluation;
- the LSP fleet (`LS`), fenced by the LSP service generation;
- the registry entry (`RE`) and its re-registration intent.

**Scopes.** Each activation gets a scope: a process-unique ticket with a role
(primary or secondary), a session file and a branch epoch (D1: cells are per
scope, not per entry-module evaluation). The module-level `runtime` is modelled
as `last`, the scope the most recent primary `session_start` served.

**Host transitions** (pi 0.85.1, design section 1.1):

| Transition | Modelled as |
|---|---|
| `/new`, resume, `/fork`, `/clone` | `session_before_fork` (fork and clone only), then `session_shutdown`, then the new activation's `session_start`. Shutdown and start are separate steps, so a writer can land between them. `/fork` copies the branch without its last entry; `/clone` copies all of it. |
| `/reload` | The same, on the same file. The start may re-evaluate the entry module (jiti fallback, design section 1.3), which restarts a per-evaluation order turn (N3). |
| cancelled fork | Another extension cancels after pi-lens' `session_before_fork` handler ran (I3). |
| quit, `pi --fork` | Quit ends the process, and in-flight work dies with it. `pi --fork` then starts a new process whose only channel is the parent's sidecar. |
| `/tree` | The same activation. The branch loses its last entry and the branch epoch bumps. |
| LSP idle reset | pi-lens' own timer. It resets the LSP service only. |
| secondary start/stop | An in-process subagent binds its own session while the primary is live (I6). It skips `handleSessionStart` (#473). |
| duplicate start | A second `session_start` for the same replacement (I5, #2890). |

**Writers.** Each writer begins once in a live scope and lands at any later
step. pi refuses `/tree` and `/reload` while streaming, but `agent_settled`
handlers run after the run is marked inactive (I1), and bounded handlers are
abandoned without being cancelled (I2). This over-approximation hides nothing
the host allows.

- `read`: a primary read-guard write. Its uncaptured form (without
  `entryCapture`) is `recordWritten` (authorship), which resolves the runtime
  when the mutation lands (`clients/mutation-bridge.ts:256`, `:267`), and the
  `agent_settled` drain's write (the G10 F1 race). Today's native read record
  already captures the guard object at hook entry (`index.ts:2763` passes
  `runtime.readGuard`), and `resetForSession` drops that object
  (`clients/runtime-coordinator.ts:562`). So master already loses a late
  native read on every primary start: the F1 loss on `/reload` and resume is
  not new.
- `secRead`: the same in a subagent.
- `heartbeat`: the registry heartbeat's repair.
- `lsp`: LSP work that can spawn a server (#3576).
- `widget`: a pipeline verdict write to the widget in the current turn.

**Which entry a read-guard writer holds** is the constant `LateHandlers`.
With `FALSE`, the writer holds its branch's newest entry: the tool result its
handler is processing. With `TRUE`, it holds any entry of its branch, because
its handler outlived a later entry (a handler abandoned under I2 while the
next tool result was recorded). Every config uses `TRUE` except
`NewestReadTreeFork`, `AcceptedLateReadReload` and `AcceptedLateReadResume`.

**Policies are constants** (design section 4). A config picks `TargetPolicy`
or `TodayPolicy`, `TargetFence` or `TodayFence`, and `TargetSec` or `TodaySec`.

| Store | startup | /new | resume | /fork, /clone, pi --fork | /tree | /reload | shutdown | idle | Secondary | Fence |
|---|---|---|---|---|---|---|---|---|---|---|
| `RG` target | rehydrate | reset | rehydrate | import-parent | filter-by-branch (D8) | filter-by-branch (D5) | none | none | own | branch |
| `RG` today | rehydrate | reset | rehydrate | reset | none | reset (N1) | none | none | shared (#3607) | session |
| `TC` | reset | reset | reset | reset | none | reset | none | none | own (today: shared, N2) | session |
| `WG` guards | reset | reset | reset | reset | carry | carry | none | none | shared | none |
| `LS` | none | none | none | none | none | none | reset | reset | shared | service |
| `LT` lens toggles | reset | reset | reset | reset | none | reset | none | none | shared | none |
| `LZ` lazy tools | rehydrate | reset | rehydrate | import-parent | none (D7) | carry | none | none | shared | none |

- `LT` follows D6, which was not approved: today's per-activation reset, on
  every transition that starts a new activation. `LT` and `LZ` carry no model
  state, because no invariant reads them; they are listed so that the table is
  whole.
- Today's `RG` fork and clone entries are `reset` in effect. The fork stash is
  an activation-closure `let` (`index.ts:1078`), and pi re-runs the factory on
  a fork, so the fork's new activation cannot see it.
- The target and today differ only in the `RG` row, the `TC` secondary
  policy, and the `RG` fence.

**`FixParts` selects the mechanisms:**

- `entryCapture` (D2): writers capture their lineage handle at hook entry.
  Without it, the handle is resolved when the write lands: from the
  module-level runtime, or, for the heartbeat, from the registry intent.
- `handoffAtShutdown` (D3): the hand-off slot is written at `session_shutdown`,
  with `targetSessionFile`. Without it, the slot is written at
  `session_before_fork`, as in the G10 design.
- `consumeOnMatch` (the F2 decision, amending section 3.4): a `session_start`
  consumes the slot only when the slot names its previous session file and,
  under D3, the `targetSessionFile` it was started for. An unmatched slot
  stays in place. Without it, every start takes the slot and discards it when
  unmatched, as section 3.4 is written.
- `processOrderTurn`: the write-order turn is a process counter (the design's
  `nextOrderTurn`). Without it, the turn is a field of each entry-module
  evaluation (G5's `_writeOrderTurn`).
- `dedupe`: the #2890 duplicate-start gate.
- `recordDrop` (the F1 decision): a dropped read-guard write whose entry is
  still on the branch of the writer's conversation leaves a record. It stands
  for the degradation-ledger record (`recordDegradationOnce` or
  `incrementDegradationCount`) that S1 adds. The model keeps every record;
  bounding them to one per session is the code's job.

## Invariants

| Invariant | Meaning | Design section 6 name |
|---|---|---|
| `NoCrossSessionState` | A live scope's read-guard cell holds only its own facts and the facts it inherited. The registry entry holds only live roots. Every LSP server belongs to the current service generation. | `NoCrossScopeWrite` |
| `NoStaleBranchWrite` | A live scope's own-lineage facts name entries on its current branch. | `NoOffBranchFact` |
| `NoLostCarry` | Every fact that reached a cell in the live scope's conversation lineage, on an entry that conversation still holds, is in the cell the scope reads. | `NoLostCarry` |
| `NoFalseBlock` | The same, over every read-guard write that completed, whether it landed or a guard dropped it. It implies `NoLostCarry`. The adopted design violates it (F1, accepted), so only `AcceptedLateRead*`, `NewestReadTreeFork` and `Current` check it. | (new) |
| `NoUnrecordedFalseBlock` | `NoFalseBlock` over the writes that left no drop record: every false block is recorded. | (new) |
| `NoOwnDrop` | No guard drops a write whose own lineage is still current (catalog shape 54). | (new) |
| `SecondaryIsolation` | A primary transition never removes a live subagent's own facts, and a subagent's turn never moves the primary's turn. | `SecondaryIsolation` |
| `HandoffOnce` | The slot is consumed at most once, and only by the primary start that replaced the scope that wrote it. | `HandoffOnce` |
| `OrderMonotone` | A write-order token drawn later outranks every earlier one, across `/reload` and entry-module evaluations. | `OrderMonotone` |
| `OneResetPerScope` | One `session_start` mutation pass per scope. | `OneResetPerScope` |
| `NoForeignFact` | A live scope's cell holds only facts of its own conversation lineage, on its current branch (proposed in the S9 review). The invariants above take lineage membership as a premise; this one catches a lineage truth that omits a scope, which would make them vacuous for its facts. | (new) |

The conversation lineage the invariants check is per file (`lin`), and
`/fork`, `/clone` and `pi --fork` copy it. It is the truth, and it is
independent of the policy under test, so a `reset` policy cannot hide the loss
it causes.

## Bounds

A pass holds only inside these bounds:

- **Each transition kind happens at most once per behaviour** (`k \notin used`
  in `RetireOk`, `BeforeFork`, `Tree`, `IdleReset` and `SecStart`), and `Fix`
  allows three transitions in a row (`MaxSteps = 3`).
- **One `/new` target.** `/new` always creates file `N`. This is why the
  once-per-kind bound is load-bearing for `/new`. Without it, a second `/new`
  lands on the same file `N` as the first, whose lineage then holds the first
  `/new`'s scope. That is a model artifact, not host behaviour: `Fix` then
  violates `NoLostCarry` on a trace of `/new`, a read in session `N`, and a
  second `/new` that "resets" the same conversation. For `/reload` and
  resume the bound is not load-bearing: with it lifted for those two kinds,
  `Fix` still passes (76839 distinct states).
- **`/tree` only on a two-entry branch**, and it drops the last entry.
- **One writer of each kind** begins per behaviour. `MaxTurns` is 1 in `Fix`
  and 3 in `FixOrder`.
- **One subagent** (file `S`), and no time.

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4). Every config ran through
`node scripts/check-tla-models.mjs --concurrency 1` with one TLC worker, on a
32-core machine at load average about 5. The 24 configs took 20.1 s serial in
total. A violated config stops at its first counterexample.

| Config | Models | Expect | States | Seconds |
|---|---|---|---|---|
| `Fix` | adopted design: every transition, a primary and a subagent reader, one turn | pass | 72346 | 3.3 |
| `FixProcess` | adopted design: heartbeat and LSP work across `/new`, resume, `/reload`, idle reset, quit, `pi --fork` | pass | 24771 | 1.6 |
| `FixOrder` | adopted design: widget tokens over three turns across `/new`, `/reload`, quit, `pi --fork` | pass | 319 | 0.7 |
| `NewestReadTreeFork` | F1 bound: a reader of the newest entry across `/tree` and `/fork` | pass | 42 | 0.7 |
| `AcceptedLateReadTree` | F1 on `/tree`, a handler that outlived a later entry | violated `NoFalseBlock` | 11 | 0.7 |
| `AcceptedLateReadFork` | F1 on `/fork`, a handler that outlived a later entry | violated `NoFalseBlock` | 23 | 0.7 |
| `AcceptedLateReadReload` | F1 on `/reload`, a reader of the newest entry | violated `NoFalseBlock` | 12 | 0.7 |
| `AcceptedLateReadResume` | F1 on `/new`, then resume, a reader of the newest entry | violated `NoFalseBlock` | 28 | 0.7 |
| `MutSettleDuringTree` | G10 F1: the drain writer races `/tree`, fenced at session level only | violated `NoStaleBranchWrite` | 12 | 0.7 |
| `MutTreeCarries` | master: no `session_tree` handler | violated `NoStaleBranchWrite` | 14 | 0.7 |
| `MutForkClosureStash` | master: the fork stash is per activation | violated `NoLostCarry` | 24 | 0.7 |
| `MutStalePipelineAfterNew` | `recordWritten` lands after `/new` | violated `NoCrossSessionState` | 18 | 0.7 |
| `MutLspAfterIdleReset` | LSP work spawns after the idle reset | violated `NoCrossSessionState` | 8 | 0.7 |
| `MutHeartbeatBeforeRegistration` | a heartbeat lands before the new registration | violated `NoCrossSessionState` | 10 | 0.7 |
| `MutSecondaryTurnStart` | a subagent's `turn_start` advances the primary's turn | violated `SecondaryIsolation` | 5 | 0.7 |
| `MutTreeWipesSecondary` | the primary's `/tree` filters the subagent's reads | violated `SecondaryIsolation` | 9 | 0.7 |
| `MutSecondaryReadShared` | a subagent's read lands in the primary's read guard | violated `NoCrossSessionState` | 4 | 0.7 |
| `MutReloadReset` | `/reload` resets the read guard | violated `NoLostCarry` | 21 | 0.7 |
| `MutOrderTurnPerEval` | a re-evaluation restarts the order turn | violated `OrderMonotone` | 19 | 0.7 |
| `MutWidgetDropAfterReEval` | the same; the widget guard drops the live verdict | violated `NoOwnDrop` | 70 | 0.7 |
| `MutSnapshotAtBeforeFork` | the G10 slot is filled at `session_before_fork` | violated `NoLostCarry` | 28 | 0.7 |
| `MutSecondaryTakesHandoff` | a subagent's start takes the slot and discards it | violated `HandoffOnce` | 7 | 0.7 |
| `MutDuplicateStart` | no #2890 gate | violated `OneResetPerScope` | 2 | 0.7 |
| `Current` | master: today's tables, no capture for the #3596 writers, per-evaluation order turn | violated `SecondaryIsolation` | 55 | 0.7 |

## Mut configs and their issues

Provenance: "master" is today's code; "pre-fix" is code before a fix that has
landed; "design alternative" is a shape that the adopted design rejects (G10's
work in progress, or section 3.4 as written), not code that shipped.

| Config | Issue | Provenance | Shortest counterexample |
|---|---|---|---|
| `MutSettleDuringTree` | #3521 (the G10 F1 review race) | design alternative: G10's work in progress, fenced at session level with no branch epoch | A read of entry 2 begins, `/tree` drops entry 2, and the read lands. |
| `MutTreeCarries` | #3521, tree half | master: no `session_tree` handler | A read of entry 2 lands, then `/tree` drops entry 2 and the read stays. |
| `MutForkClosureStash` | #3521 fork half; the #3589 shape | master: `pendingForkSnapshot` and `pendingForkReadGuard` are closure `let`s (`index.ts:1078-1082`) | A read lands, then `/fork`: the fork starts clean. |
| `MutStalePipelineAfterNew` | #3596; also the #3528 drain shape | master: `recordWritten` resolves the runtime when the mutation lands (`clients/mutation-bridge.ts:256`, `:267`). This is authorship. A native read record captures the guard at hook entry, so it drops instead (F1). | A write begins, `/new` completes, and the write lands in session 2. |
| `MutLspAfterIdleReset` | #3576 | pre-fix: before G5's `captureLspServiceGeneration` (#3602) | LSP work begins, the idle reset runs, and the work spawns a server. |
| `MutHeartbeatBeforeRegistration` | #3498 | pre-fix: the pre-#3498 heartbeat; the lock-level detail is `formal/session-registry` (`StaleIntent`, `Replacement*`) | A heartbeat begins, session 1 shuts down, and the heartbeat re-registers session 1's root from the intent before session 2's registration lands. |
| `MutSecondaryTurnStart` | N2 | master: `onTurnStart` calls `runtime.beginTurn()` with no role gate (`index.ts:2817-2829`) | The subagent starts, and its `turn_start` moves the primary's turn. |
| `MutTreeWipesSecondary` | #3607 | design alternative: G10's `/tree` filter over master's shared read guard (master has no `/tree` filter) | The subagent's read lands, and the primary's `/tree` filters it away. |
| `MutSecondaryReadShared` | F4 | master: the subagent shares `runtime.readGuard` | The subagent's read lands in the primary's cell. |
| `MutReloadReset` | N1, under D5 | master: `resetForSession` on every primary start (`clients/runtime-session.ts:2463`); reload imports nothing | A read lands, and `/reload` starts clean. |
| `MutOrderTurnPerEval` | N3; #3540 case A | master: `_writeOrderTurn` is a coordinator field (`clients/runtime-coordinator.ts:446`). N3 fires only if the entry module is re-evaluated in production, and that residence is unverified [I] (design N3). | A turn draws token 1, `/reload` re-evaluates the entry, and the next turn draws token 1 again. |
| `MutWidgetDropAfterReEval` | N3's harm; #3540 | master, under the same unverified residence [I] | Two turns, and a widget write at token 2. After `/reload` with re-evaluation, a turn draws token 1, and the widget guard drops the live session's own write as older. |
| `MutSnapshotAtBeforeFork` | D3 check | design alternative: the G10 slot at `session_before_fork` | `session_before_fork` fills the slot, a read lands, then shutdown and start: the fork lacks the read. |
| `MutSecondaryTakesHandoff` | design finding F2 | design alternative: section 3.4 as written | `/reload`'s shutdown fills the slot, and a subagent's `session_start` takes it. |
| `MutDuplicateStart` | #2890 | pre-fix (guard mutant) | A duplicate start re-runs the reset. |
| `Current` | today's first counterexample | master | N2, in three states. |

Before #3583 and #3602 merged, the same shape as `MutStalePipelineAfterNew`
also covered the `agent_settled` drain's writes after `/new` (#3528, #3576).

## Design findings

**F1. A dropped late read is a false block, and the design accepts it.** The
design's `store.write` drops a write whose handle is not current at the
store's fence (design section 3.2), and `retireScope` drops a retired scope's
late writes (section 3.4). When the live conversation still holds the dropped
write's tool result, the next edit of that file is a false block.

Where it occurs, measured with `LateHandlers`:

- **`/reload` and resume are the real exposure.** A handler still processing
  the newest tool result when `/reload` or `/new` fires lands after
  `session_shutdown` and drops. `/reload` keeps the conversation, and resuming
  the same file brings it back (`AcceptedLateReadReload` and
  `AcceptedLateReadResume`, both with `LateHandlers = FALSE`). On master the
  native read path already loses these reads (see `read` above).
- **`/tree` and `/fork` lose a read only when its handler outlived a later
  entry.** `/tree` drops the newest entry and `/fork` restarts before it, so
  dropping a read of the newest entry is correct (`NewestReadTreeFork`
  passes). A read of an older entry that stays on the branch needs a handler
  that outlived the next tool result (`AcceptedLateReadTree` and
  `AcceptedLateReadFork`, with `LateHandlers = TRUE`).

Decision (2026-09-30, A + C): the design keeps dropping every stale write. A
dropped read whose entry is still on the branch leaves one bounded
degradation-ledger record, so the loss is measured. The forwarding amendment
that round 1 proposed is not adopted. `recordDrop` models the record, and
`NoUnrecordedFalseBlock` checks that every false block `Fix` reaches is
recorded. The record's condition reads the writer's own conversation branch
at drop time, because in the shutdown gap no successor branch exists yet. The
model cannot see a record that is too wide (a correct drop recorded as a
loss): no invariant reads one, so the precision of the count is for the S1
code's tests.

**F2. A subagent's `beginScope` can consume the hand-off.** Section 3.4 has
`beginScope` call `takeHandoff()` once and discard an unmatched slot, and
section 3.5 has every secondary call `beginScope`. A subagent that binds
between a primary's `session_shutdown` and its successor's `session_start`
(I6, during the replacement's async gap) therefore consumes the slot as
unmatched, and `/reload`, whose `carry` has no sidecar fallback, loses every
read (`MutSecondaryTakesHandoff`). The defect is the discard, not the
subagent's role.

Decision (2026-09-30): consume the slot only on a match, and leave an
unmatched slot in place (`consumeOnMatch`). This replaces the role-gated take
that round 1 proposed. The model's subagent is correctly classified as a
secondary. On today's classifier, a subagent binding in that gap is
classified `primary` and demotes the real primary. That reachable hole is
outside this model and is tracked in #3662. Whether a subagent binds in that
gap in practice has not been replayed [I].

**F3. The file match is now load-bearing, for the subagent's take.** With
`consumeOnMatch`, the match is what keeps a subagent's start off the slot:
replacing it with `slot.has /\ slot.takenBy = 0` in the subagent's take reds
`Fix` (`HandoffOnce`). The model cannot separate the match's two conjuncts.
The subagent has neither the slot's previous file nor its target, so either
conjunct alone rejects it. A primary start's match still cannot be made red
in-process under D3: every primary start directly follows its predecessor's
retire, so it always matches. It stays for in-memory sessions, which have no
files.

**F4. Today, a subagent's read authorises the primary's edit** [I]. The shared
read guard puts a subagent's read in the primary's cell
(`MutSecondaryReadShared`), so the primary may edit a file it never read. The
design's `own` secondary policy for the read guard removes this.

**Confirmations.**

- D3: `MutSnapshotAtBeforeFork` violates `NoLostCarry`. A read that lands
  between `session_before_fork` and `session_shutdown` is missing from a slot
  filled at `session_before_fork`.
- D5: `MutReloadReset` violates `NoLostCarry`. Carrying authorship on
  `/reload` is required, not merely safe.

## Scope

Not modelled:

- **Content.** Staleness, FileTime, hashes and ranges are covered by
  `formal/read-guard`; the quiet window's tasks by `formal/session-straddle`;
  the drain by `formal/format-drain`; the registry lock and tail by
  `formal/session-registry`.
- **#3587** (a shutdown that meets this process's own registry lock skips
  the deregistration). Here `Retire` deregisters unconditionally, and there
  are no secondary roots.
- **N4** (per-evaluation generation numbers). Scope ids here are tickets, so
  two evaluations never share one.
- **N5** (the turn summary and test-runner delivery after `/tree`), and #3603
  (authorship on `/tree`: G10 resets it, and the table keeps that).
- **The ALS hazard of D2.** A long-lived resource that inherits a stale
  ambient handle (design section 3.3, item 5) is not modelled.
- **D4** (tool-call id reuse across branches). Entries are unique here.
- **The widget's write token.** `WidgetWrite` allows one write per turn, and
  its token is the bare order turn, where the real token is
  `(orderTurn, writeIndex)`. So the guard's `>=` and `>` cannot be told apart
  here (replacing one with the other still passes `FixOrder`), and the order
  of writes within one turn is not checked.
- **Time**, the cwd-changing resume's re-evaluation, the MCP host, and more
  than one subagent.
