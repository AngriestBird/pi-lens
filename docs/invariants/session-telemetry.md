<important if="touching session, telemetry, and delivery rules">

### Session, telemetry, and delivery

- Registry root ownership (#3849): each holder's record in a pid entry's
  `projectRootHolders` lists exactly the roots THAT holder registered (`host`
  for `registerInstance`, a per-activation id for a declined secondary). Only
  its own `deregisterInstanceRoot`, whole-entry removal, or cap eviction ends
  a record; a root stays while any record lists it. No anonymous counts; one
  settle (`settleRootHolders`) for every writer; `getInstanceRoots` reads.
- Session state is owned by the stable session identity and activation owner.
  Detached callbacks resolve live emitters at delivery time and pair them with
  their own activation context. Never use a process-global latest session.
- Process-global bridge dependencies and the quiet-window turn-summary holder
  bind only from a live primary `SessionScope`; `clients/process-bridge.ts`
  accepts only a strictly newer scope ticket, so a concurrent secondary or
  stale activation cannot rebind a held bridge/task to its runtime (#4258).
- Session degradation uses the ledger's bounded once/count APIs and resets at
  the correct primary session boundary. `SessionStartClassification`
  (`clients/session-lifecycle.ts`): `primary` and `sequential-replacement`
  (resume and reload) both run the full start and reset; only
  `concurrent-secondary` skips the reset, since a subagent reset tears down the
  primary's warm state. `secondary` belongs to the shutdown classification. A process-lifetime latch cannot store a
  session fact without an explicit reset.
- Turn state is the turn's session's (#3613): `RuntimeCoordinator.beginTurn`
  takes the ctx's stable session id and moves the coordinator's counters,
  write-order turn and change window only for its own session, and per-turn
  warnings are partitioned by the session that recorded them. Every
  producer and reader passes that id (`tool_result`, a partial apply's
  pipeline, `turn_end`). The read guard is the turn's session's too (#4942,
  the half of #3613 this paragraph used to leave open):
  `RuntimeCoordinator.readGuardFor(sessionId)` answers with the coordinator's
  own guard for a turn with no session id of its own, and with a guard of its
  own, built on first use and dropped at its shutdown, for a concurrent
  secondary. It keys that guard by the opaque owner the inline blockers use
  (#4921, `recordSession`), so an edit is judged by the reads and writes of
  the session that edits. The coordinator's own guard is the primary's only
  while the ctx's stable session id equals the pinned telemetry id
  (`setSessionLifecycle`); a start that cannot read its id would leave the
  primary's turns on a foreign guard, where a primary `/tree` no longer
  filters their reads (a hypothesis, reproduced only as a composite probe,
  #4955 review F3).
  A read or write reported through the mutation or
  read bridge names no session and is the coordinator's. A concurrent
  secondary still shares the turn-end worklist. State `turn_end` parks
  in a scope cell for a later turn lives on the activation's own scope
  (`TurnEndDeps.sessionScope`, passed by `index.ts`), never on
  `runtime.sessionScope`, which is the primary's during a secondary's turn
  (#4154: the late dead-code scan). A turn-end drain or write-back is fenced
  by the scope that owns the store, taken at entry (#4161, #4168 round 3):
  the coordinator's for the coordinator and module stores a secondary
  shares, the activation's for its own scope cell. One store never answers
  to two scopes, and a secondary's end fences only its cell.
- Every session-scope hand-off decision leaves one `latency.log` row per
  lifecycle event, never one per occurrence in a loop (#3873):
  `session_handoff_slot`, `session_handoff_adopt`, `session_store_action`
  (a store's `restore` returns its `StoreCarry`, items in and kept),
  `session_scope_transition` (`end`, `demote`) and `session_end_fence_rollup`.
  `docs/pi-lens-monitor.md` lists the fields; a new session store or hand-off
  branch adds its row there in the same change.
- Logger writes use `createNdjsonLogger`; flush before reading a log. Redact at
  the sink. New failure records preserve the discriminating file/tool/record
  identity and retain dropped counts.
- `memory_sample` remains one bounded latency record. Its heap, external,
  worker-isolate, tree-sitter, and word-index fields are latest-value or O(1)
  reads; sampler assembly time is recorded in `samplerDurationMs`.
- Delivery surfaces are registered in `clients/finding-delivery-gate.ts`.
  Every model-facing diagnostic, blocker, advisory, widget, nudge, and snapshot
  either passes the shared freshness/disposition gate or carries an explicit
  bounded age label.
- The dispatcher coverage notice (`buildCoverageNotice`) latches once per
  session (`coverageNoticeSeen`) for the pi push surface; pull surfaces
  (`pilens_analyze`, including its warm PostToolUse hook route) pass
  `dedupeCoverageNotice: false` so every call carries the notice and the push
  latch stays untouched (#3791). The warm hook deliberately repeats the notice
  on every edit, matching its cold hook route. A primary off in
  `lsp.disabledServers` gets one "disabled in config" note per server per
  session instead of the per-file notice.
- `pilens:files:touched` publishers are `clients/pipeline.ts` and
  `clients/runtime-agent-end.ts`; `clients/agent-nudge.ts` is the subscriber.
  `clients/lsp-mutation.ts` has an optional callback but is not a publisher until
  it is wired. Update `tests/config/files-touched-bus-conformance.test.ts` for
  any publisher or subscriber change.
- Deferred work has a bounded queue, wall budget, abort path, carry-forward
  identity, and honest partial/deferred delivery. It never publishes a false
  clean result after cutting work.

</important>
