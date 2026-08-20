---
section: Fixed
---

- **`loop_block` now names a synchronous block still in progress** — a
  current-phase slot (`clients/latency-logger.ts`) records when a dispatch
  runner starts, not only when it finishes, so an event-loop block sampled
  mid-scan attributes to the phase actually running instead of the previous,
  unrelated one that already completed (#1723).
