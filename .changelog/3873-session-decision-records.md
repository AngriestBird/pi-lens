---
section: Changed
audience: user
---

- `latency.log` now records the session-scope decisions that left no trace: `session_handoff_slot` (a hand-off slot stashed, replaced, taken, left for another start, forwarded or never consumed), `session_handoff_adopt` (the candidates a start tried and why each fell through), `session_store_action` (each store's adopt, reset or skip with items in and kept), `session_scope_transition` `end` and `demote`, and `session_end_fence_rollup` (writes each generation fence admitted or dropped); `read_guard_branch_retained` gains `payloadReads`, `session_start_total` gains `basis`, `gapMs` and `lineageMatch`, `agent_nudge` gains `fileKeys`, `originSessionIds`, `scopeId` and `queueEpoch`, a no-client `lsp_touch_file` gains `candidates`, and a formatter give-up writes one `format_late_resync_chained` row per file (#3873).
