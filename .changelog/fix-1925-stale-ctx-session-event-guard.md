---
section: Fixed
---

- **Session events on a replaced session no longer throw into the host (closes #1925)** — pi invalidates a captured extension ctx on `newSession`/`fork`/`switchSession`/`reload`, and an event already queued when that happens still reaches pi-lens carrying the dead ctx. `tool_result`, `turn_start`, `agent_end`, and `turn_end` each read a ctx property before any guard, so the SDK's `assertActive()` error escaped into pi. All five session-event registrations, including `agent_settled` (#1924), now go through one wrapper in `clients/session-event-guard.ts`: it probes the ctx once before dispatch, still classifies a stale throw that races in mid-handler, and records every skip in the degradation ledger under `extension-ctx-stale` plus a bounded `session_event_stale_ctx_skip` row in `latency.log`, keyed by event name. A new registered-or-fail sweep reds any future `pi.on` registration that is neither wrapped nor given a stated reason.
