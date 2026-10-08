# Turn-end late scan model

A TLA+ model of the dead-code lane's late scan: a vulture scan that misses the
`turn_end` budget is parked, writes its baseline row where it settles, and has
its delta delivered by a later `turn_end` (`clients/runtime-turn.ts`
`parkLateDeadCodeScan`, `lateDeadCodeScansOf`, the dead-code block of
`handleTurnEnd`; #4117 round 2, PR #4120). Every config here states its
expected verdict on its first line, and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3803 (the lane that wrote this family), #4117 (the late scan and the
back-off), #4120 (the PR), #4154 (V1 and J1 below, fixed). The knip memo (#3893, #3903, #4116) is mapped to this
family but not modelled; see "What the model cannot see".

Source line numbers in `LateScan.tla` are at master `b73d4ceaf`. The symbol next
to each is the stable anchor.

## What the model covers

One lane is one (client, root). The model keeps:

- **The baseline row** `dead-code-<id>`: absent, good, or a failed scan, plus the
  edits its scan had seen.
- **The vulture process** with the client's single flight
  (`clients/dead-code-client.ts` `analyze`): a second `analyze` while one runs
  JOINS it and gets the older result.
- **The awaiting handler** (`await bounded(scan, ...)`, `runtime-turn.ts`
  `handleTurnEnd`): it finishes inside the budget (`InlineFinish`) or gives up
  (`Abandon`, which parks).
- **The parked entries** and the per-session cell that holds them
  (`lateDeadCodeScansOf`).
- **The client's hard-failure mark** (`HardFailureStamps`) and the failed-row
  latch, the two readers of the back-off.

| Action | Source | What it does |
|---|---|---|
| `Edit` | `modifiedFiles`, `runtime-turn.ts:2554` | The agent edits a file. |
| `TurnEndStart` (InlineScan) | `:2693-2727` | No entry: start the scan and await it. |
| `TurnEndCarry` | `:2688-2692` | An entry is in flight: this turn's files join its carry; no scan starts. |
| `TurnEndTake` | `:2677-2686`, `:2693` | A settled entry is delivered once and removed; its carry, and a joined entry's own files (#4154), join this turn's scan files. |
| `TurnEndSkip` | `:2703-2718` | The back-off: the root is skipped. |
| `InlineFinish` | `:2755-2786` | The scan ended inside the budget: the inline writer compares a failure with the row on disk once the scan settled (#4154). A joined await is not finished here (`Join`). |
| `Abandon` (Park) | `:2737-2753`, `:608-629` | `bounded()` gave up, or the await joined a scan already running (#4154). The entry records the scan's files, the row it started against and whether it joined. |
| `ScanComplete` | `dead-code-client.ts:458-471` | The process ends: ok, fail (timeout or kill) or threw. The client stamps a failure here. |
| `EntrySettle` (Settle, Drop) | `:630-663`, `:587-600` | The `.then` handler: an ended session writes nothing; otherwise the row is written unless it would poison; a failure drops the entry; a success is parked. |
| `SessionReplace` | `runtime-coordinator.ts:652-654` | `/new`, fork, reload or quit retires the scope; the new scope has its own cell. |
| `ForeignWrite` | `project-diagnostics/fresh-fetch.ts:858-870` | `lens_diagnostics` stores a good row from outside the lane. |
| `Expire`, `ExpireBadRow` | `hard-failure-summary.ts:20`, `cache-manager.ts:218` | The 30 minute mark expires; a failed row ages out. |

## Invariants

| Invariant | Meaning | Recurrence it names |
|---|---|---|
| `SingleWriter` | One scan result is written to the row once: the inline writer while no entry exists, the settle handler while one does. | A turn_end that starts beside a parked scan writes the same result twice (the entry's exclusion is what makes the settle handler the only writer). |
| `NoCrossSession` | An ended session's settle writes nothing; no entry is delivered in another session. | The `isCurrentSession` check at `:632`; round 1 of the entry kept a module-level map (commit 64d783a99 moved it to the scope cell). |
| `NoPoison` | A failed scan never replaces a good row. | #925, #1467: a 194-byte failure replaced 149 KB of findings in every dogfood project. |
| `NoLostEdit` | A file edited while a scan runs is in the carry of a live entry until a started scan covers it, or it was lost with a counted drop. | The carry add at `:2689`. |
| `NoSecondStart` | No scan starts while an entry is in flight. | The in-flight branch at `:2688`. |
| `NoDoubleDelivery` | A scan's result is delivered as a delta at most once. | The `delete` at `:2678`. |
| `NoOrphanScan` | A running scan always has a consumer: the awaiting handler or a live entry. | Review F1 of #4120 round 1: `bounded()` abandoned the await and nothing kept the scan, so a slow root got no row and no delta. |
| `NoLostRow` | After a live handler saw a successful scan, the row is a good row at least that fresh. | A handler that sees the result and drops it. |
| `NoRespawnWhileStamped` | A scan that died to a timeout or kill is not respawned until the mark expires or a scan succeeds. | #4117: a scan abandoned at its budget that later timed out left no mark, so every later turn spawned another 30 s vulture. |
| `NoLostEditStrict` | A counted drop loses no carried edit. | VERIFY_4120 V2. Registered as violated. |
| `NoStaleCover` | A file is never left with only a result that predates its edit: a joined result is not finished inline, and its files join the next scan. | #4154 J1, the cross-session join below. |

The liveness-shaped half of the lane ("the late result lands") is two bounded
safety checks, `NoOrphanScan` (a scan is kept) and `NoLostRow` (a kept result
reaches the row). The model has no fairness assumption, so it cannot say the
delta arrives; it says nothing drops it.

## Configs

States are TLC's generated / distinct counts (`-workers 1`), at `Edits =
{1, 2, 3}`, `MaxSess = 2`, `MaxScan = 3`, `MaxEnt = 3`. A violated config's count
is up to the first violation (BFS, so the trace is a shortest one).

| Config | Expect | States | What it proves |
|---|---|---|---|
| `Merged` | pass | 39 090 / 19 114 | The shipped design (#4120 round 2 plus #4154) with the lane's own writers: every invariant above except `NoLostEditStrict`. |
| `SettleAfterEnd` | violated `NoCrossSession` | 874 / 694 | Without the scope liveness check a scan that ends after `/new` writes the row. |
| `SettleWritesPoison` | violated `NoPoison` | 569 / 457 | Without `wouldPoisonCache` at the settle a failed late scan replaces a good row. |
| `InlineWhileParked` | violated `SingleWriter` | 7 208 / 4 279 | Without the in-flight branch a turn_end starts its own scan beside the parked one and both write. |
| `PreRound2Dropped` | violated `NoOrphanScan` | 47 / 40 | Round 1: nothing keeps an abandoned scan. |
| `SettleDropsResult` | violated `NoLostRow` | 335 / 273 | A handler that drops a successful result leaves the row behind. |
| `CarryNotRecorded` | violated `NoLostEdit` | 324 / 263 | Without the carry add an edit made while the scan runs is covered by no scan. |
| `EntryOnModule` | violated `NoCrossSession` | 2 090 / 1 479 | A module-level entry map delivers one session's result in the next. |
| `BackoffUnread` | violated `NoRespawnWhileStamped` | 1 465 / 1 089 | A reader that ignores the client's mark respawns after a hard failure the good row hid. |
| `StampAtTurn` | violated `NoRespawnWhileStamped` | 3 090 / 2 190 | A client that stamps only a failure settled inside the turn leaves a parked failure unmarked. |
| `FailedScanDropsCarry` | violated `NoLostEditStrict` | 2 031 / 1 443 | VERIFY_4120 V2, a documented degradation: a failed in-flight scan drops the files carried for it. |
| `JoinedScanStale` | pass | 39 090 / 19 114 | #4154 J1, fixed: after a session replacement the new session joins the old session's running vulture; the joined result is parked and its files join the next scan. Same constants as `Merged`, kept under the name the issue registered. |
| `JoinedScanTrusted` | violated `NoStaleCover` | 4 491 / 2 769 | The pre-#4154 join (`Join = "trust"`): the joined result is the answer for edits it predates. |
| `ForeignRowPoison` | pass | 145 345 / 67 691 | VERIFY_4120 V1, fixed by #4154: with a foreign writer, both writers compare a failure with the row as it is when the scan settled. |
| `ForeignRowStartGuard` | violated `NoPoison` | 1 486 / 1 164 | The pre-#4154 guard (`Poison = "start"`): the row the scan started from, so the foreign good row is replaced. |

`JoinedScanStale` and `ForeignRowPoison` were registered `violated` by #4153 on
the `SecRootSharedTwo` precedent in `formal/session-registry` and flipped to
`pass` by the fix (#4154); each keeps a `violated` witness of the old
behaviour (`JoinedScanTrusted`, `ForeignRowStartGuard`), so the guard stays
load-bearing in the model. Mutation check for the two halves of `Join =
"carry"` against the unchanged `Merged.cfg`: the Take without the joined
entry's files reds `NoStaleCover` (15 156 / 8 392), and `InlineFinish` without
the joined guard reds `NoStaleCover` (4 295 / 2 769).

## Findings

- **V1 (`ForeignRowPoison`), fixed by #4154.** Before the fix, `parkLateDeadCodeScan` guarded the write with
  `entry.previousScan`, the row read when the scan started, and the inline path
  does the same with `prev`. A good row stored meanwhile (`lens_diagnostics`
  fresh fetch) is replaced by the failure. Shortest trace: Edit, TurnEndStart
  (row absent), Abandon, ForeignWrite (good row), ScanComplete (fail),
  EntrySettle (row now failed). Reproduced through the production path: a
  parked scan that fails after a foreign good row leaves `{"ok":false,
  "summary":"Error: boom"}` where `{"ok":true,"summary":"fresh-fetch"}` was
  (a probe on the real `handleTurnEnd`, `PythonDeadCodeClient` and
  `CacheManager` with a fake vulture process; transcript in the PR).
  The window is the scan's own length, up to vulture's 30 s, on the parked
  path. The inline path has the same shape over a window of at most the budget,
  and the model keeps `ForeignWrite` out of it because the agent is stopped for
  that wait. The fix: a failure re-reads the row once the scan settled
  (`withRowForFailureWrite`, `readCacheAsync`, only when the start row was not
  good) at the settle, the inline dead-code write and knip's inline write. In
  the runtime the read and the write are two steps (an async read, then the
  synchronous write in its continuation); the model makes them one. The
  foreign writers that can land between them are other processes, which
  the unlocked store races anyway.
- **V2 (`FailedScanDropsCarry`).** An in-flight scan that fails or throws drops
  its entry and the files carried for it. The loss is counted once
  (`dead-code-late-scan-dropped`, reason `scan-failed`), the files are not
  named.
- **J1 (`JoinedScanStale`), fixed by #4154.** The entry lives on the session scope's
  cell, but the client's `inFlight` map is process-wide and nothing clears it at
  a session boundary. After `/new`, session 2 has no entry, so its `turn_end`
  starts `analyze`, which joins session 1's running vulture
  (`dead-code-client.ts:458`). The result predates session 2's edit. The carry
  that covers this case inside one session does not exist across sessions, and
  the baseline row written from the joined result does not contain the edit's
  findings, so no later scan attributes them to it. Reproduced through the
  production path with a fake vulture process whose output depends on when it
  started (transcript in the PR): same session, the edited file's finding is
  delivered; after `resetForSession`, it never is.
  The fix keeps the single flight process-wide (clearing it would start a
  second vulture beside one that cannot be aborted) and judges the result
  instead: a scan whose `scannedAt` predates the lane's call is parked even
  when it finishes in time, and when it is taken its files join the next scan
  (`joinedEarlierScan`). "delivers an edit a replaced session made while the
  old session's scan was still running" pins it.

## What the model cannot see

- **Time.** `Expire` is a nondeterministic step; the 30 minute mark and the
  cache age are not measured.
- **The knip lane.** Its late result is dropped by design (`runtime-turn.ts`
  knip block: "never written or delivered here"); the two-sample floor
  (`KnipClient.scanFloorMs`) and the 1 ms grace are arithmetic over a clock, and
  the memo (`completedByProject`, keyed by `projectSeq`) is read only by a call
  with the same `projectSeq`. The one state they share with this lane is
  `HardFailureStamps`, which the model covers. `clients/knip-client.ts` is
  mapped to this family so a change to the shared stamp class meets the model.
- **Edits while a handler awaits, and a session replacement while one awaits.**
  The agent is stopped for the budget (3 s), so `Edit`, `SessionReplace` and
  `ForeignWrite` wait for the handler. The inline continuation has no
  `isCurrentSession` check before `writeCache` (`:2766`); a replacement inside
  that window would let the old session's inline scan write the row. It is the
  same poison-guarded write the settle handler makes, and every other lane of
  `handleTurnEnd` has the same property.
- **The `.then` microtask.** Nothing runs between a scan's end and its
  handlers (`Quiet`); the model does not explore orders the runtime cannot
  produce.
- **Ownership and the delta text.** Every edited file is owned; no-previous-scan,
  `no_owned_files`, disposition filtering and the delivery cap are not modelled
  (the delivery cap and its holds are a separate family, #3813 and #3901).
- **Scans started outside the lane.** `session_start` (`runtime-session.ts:1512`)
  and the fresh fetch (`fresh-fetch.ts:858`) start `analyze` too. The lane skips
  while the startup scan runs; a turn_end that joins a fresh fetch's scan is
  handled by the same `Join` rule as `J1` (the runtime predicate does not care
  who started the scan), pinned by "parks a joined result that predates this
  turn's edit even when it finishes inside the budget". Only the fresh fetch's
  row write is modelled (`ForeignWrite`).
- **A concurrent secondary.** The model has one turn_end actor. Production has
  a concurrent in-process secondary (a subagent) on the process-singleton
  runtime (review of #4153, F2). #4154 fences it in the code, not the model: a
  late-scan entry lives on the scope of the activation whose turn parked it
  (`index.ts` passes the activation's own scope), so the secondary neither
  takes nor carries into the primary's entry, and a secondary's entry is
  dropped when its scope retires. "never hands a concurrent subagent's turn
  the primary's settled late scan" and "drops a subagent's late scan when the
  subagent ends before it settles" pin it. A join of the primary's scan by the
  secondary, or the reverse, is the same `Join` rule.
- **The back-off across sessions.** The dead-code client never clears its
  `HardFailureStamps` (knip's `resetSessionState` does), so the mark survives
  `SessionReplace`; the model follows the code, and no invariant calls it a
  defect.
- **Soft failures.** A failure here is the timeout or kill case that stamps. A
  failure that does not stamp (a non-zero vulture exit with stderr) differs only
  by never blocking.

## Replay on the real code

`tests/clients/runtime-turn-dead-code-bounded.test.ts` drives the real
`handleTurnEnd`, the real `PythonDeadCodeClient` and the real `CacheManager`
with a fake vulture process. "starts no second vulture while one is in flight"
is `TurnEndCarry`; "drops a scan that settles after its session ended" is
`SettleAfterEnd`'s guard (now the scope's liveness); "backs off a root whose abandoned scan later timed
out" is `StampAtTurn`'s and `BackoffUnread`'s guard; "delivers a slow scan's
delta on the turn after it settles" is `Abandon`, `EntrySettle` and
`TurnEndTake` together.
