---
section: Fixed
---

- **Path-attribution follow-ups: bounded orphan degradation, documented id-fallback assumption, pinned reclaim test (refs #1678, #1642, #1648)** — A deferred-format record abandoned by its origin worktree used to log a full raw event on every subsequent `agent_end` forever; it now routes through `incrementDegradationCount` so the ledger holds one bounded entry with a running count instead of unbounded per-call log lines. `resolveToolCallCorrelationId`'s widest fallback (`event.id`) now documents the assumption it makes — a host that reuses one id per message, not per call, would cross two parallel tool calls in a turn. Added a regression test pinning the already-correct "mismatch-flush leaves queued, later match-flush reclaims and formats" reclaim path.
