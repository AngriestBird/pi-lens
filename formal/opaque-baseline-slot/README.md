# Opaque baseline slot model

A TLA+ model of the pending opaque baseline that a bash call records at
`tool_call` and takes at `tool_result` (`clients/opaque-mutation-scan.ts`
`OpaqueBaselineStore`; record site `handleToolCall` in
`clients/runtime-tool-call.ts`, take site `handleToolResult` in
`clients/runtime-tool-result.ts`). Every config states its expected verdict on
its first line, and the `TLA+ models` CI job (`node scripts/check-tla-models.mjs`)
checks them all.

Issue: #4137. Lane M5 of #3803.

## What the model covers

- **Parallel calls.** pi runs the bash calls of one assistant message in
  parallel (top level and a codemode `Promise.all` alike), so every `tool_call`
  precedes the first `tool_result`. The writers are three such calls A, B, C;
  each writes the one path its own text names.
- **The store.** `Record` stores a baseline under the call's key, `Evict` is the
  record on a full store dropping the oldest (`OPAQUE_BASELINE_PENDING_CAP`),
  `Take` removes the baseline under the call's key and plans the recovery,
  `Dispatch` runs the synthetic writes after the awaits between the two. A
  baseline displaced by `Record` or `Evict` is lost to its owner.
- **Two keyings.** `Keying = "cwd"` is the pre-fix store (one key per
  `cwd:generation`); `Keying = "call"` is the fix (one key per tool-call id).
- **The second writer on the slot's evidence.** A call's recovery window holds
  its siblings' writes. A recovered path the call does not recognise is
  dispatched as opaque, without autonomous rights, and a dispatch of a path
  already analysed is skipped, so an opaque claim of a sibling's path burns the
  sibling's authored dispatch. `Subtract` models the fix: the recovery leaves
  out the recognised paths of every call whose lifetime overlapped it (the
  still-pending entries, and the calls that took a baseline after this one
  recorded).
- **Observability.** `Observe = "counted"` is the degradation ledger's
  `opaque-baseline-lost` count; `"none"` is the pre-fix `evictionCount`, which no
  production code read.

## Invariants

- `EveryWriteAttributed`: a finished call authored its own write (its authored
  dispatch reached the pipeline), so its blockers are delivered.
- `SlotLossObservable`: a displaced baseline is counted exactly once, and a call
  that finds no baseline never goes unrecorded.

## Configs

| Config | Expect | States (generated / distinct) | What it proves |
|---|---|---|---|
| `CwdKeyedSlot` | violated `EveryWriteAttributed` | 780 / 670 | The pre-fix store. TLC's shortest trace: A records, writes; B records (overwrites A's baseline); A takes B's baseline; B writes and takes: nothing found, B finishes without authorship. The real-pi witness is the same shape at width 3: `RECORD x3 (2 evictions) / TAKE found, none, none` (S8). |
| `PerCallKeyed` | pass | 5215 / 2493 | The fix: three parallel calls all keep authorship, nothing is displaced. |
| `SequentialSingle` | pass | 61 / 61 | Today's rows: calls that never overlap share the one cwd slot without loss. The fix must not move this. |
| `CwdKeyedUncounted` | violated `SlotLossObservable` | 6 / 6 | The pre-fix observability: an overwrite left no record. |
| `PerCallNoSubtract` | violated `EveryWriteAttributed` | 1745 / 1245 | Keying alone is not enough: the first call to take claims its siblings' paths as opaque and their authored dispatch is skipped (the keying-only run of the parallel-bash test: 1 of 3 authored). |
| `PerCallOverCap` | pass | 7069 / 3445 | More parallel calls than the cap: the oldest baseline is dropped and counted. Attribution is guaranteed up to the cap only; past it the loss is observable. |
| `PerCallOverCapUncounted` | violated `SlotLossObservable` | 19 / 19 | The cap eviction without its ledger record is a silent loss. |

## Counter-checks

Each knob has a config that flips when it is turned: `Keying` (`PerCallKeyed`
to `CwdKeyedSlot`), `Subtract` (`PerCallKeyed` to `PerCallNoSubtract`),
`Observe` (`CwdKeyedSlot` to `CwdKeyedUncounted`), `Sequential`
(`SequentialSingle` to `CwdKeyedSlot`), the cap (`PerCallKeyed` to
`PerCallOverCap`). Two spec mutants were run on `PerCallKeyed` and each reds
`EveryWriteAttributed`: dropping the settled-claim term (`seen[w]`) from the
sibling set (the call that took first has its dispatch in flight when a later
call recovers), and dropping the pending-entry term. A mutant that dispatches
the authored path even when it is already analysed (the content dedupe off)
turns `PerCallNoSubtract` to pass, which ties that violation to the dedupe.

## What the model cannot see

- A taker that finds a baseline another call recorded counts as holding one;
  its recovery window is that call's, which the model does not track (the real
  window starts later, so an early write of the taker can fall outside it).
- Time and the clock: windows are ordered by record, write and take steps, not
  by `startedAt` and mtime.
- The settled-claim list's own cap (`OPAQUE_BASELINE_PENDING_CAP` claims): a
  fan-out wider than the cap loses the oldest claims, a bounded edge of
  `Subtract`.
- A call whose `tool_result` never arrives leaves its entry (and recognised
  paths) in the store until the session reset or the cap.
- The recovery itself (`recoverOpaqueChangesViaGit`, `captureFileStats`) and the
  pipeline: the model keeps only the dedupe that makes the second writer
  matter.

## Replay on the real code

`tests/clients/opaque-mutation-scan.test.ts` ("parallel bash calls (#4137)")
drives the real `handleToolCall` and `handleToolResult` over a real git
repository and the real store, with the pipeline mocked at its process boundary:
three parallel calls record before any result, in the S8 order, with results
sequential and concurrent; the id-less host; the opaque sibling beside a
recognised one. The store's own cases pin the key, the sibling set, and both
caps.
