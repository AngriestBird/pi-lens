---
section: Fixed
---

- **`loop_block` now names a synchronous block still in progress** — every
  dispatch runner brackets its run with a start/finish marker
  (`clients/latency-logger.ts`), and an event-loop block attributes to
  whichever bracket — still running, or recently closed — overlaps the
  block's own time window the most, instead of only the previous, unrelated
  phase that had already finished (#1723).
