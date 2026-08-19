---
section: Fixed
---

- **Verify round: line-count memo keyed on size too (refs #1641)** — moving the line-count cache to module scope (the review round's F2 fix) introduced a HIGH finding: the memo was keyed on `mtimeMs` alone, and this host's mtime resolution (~1ms) is coarse enough that two writes in the same tick collide — truncate-then-write, a formatter write-back, a checkout, or pi-lens's own auto-format immediately followed by the agent's write. Measured live at 207/300 shrink/restore cycles serving the wrong line count, including a first-read-of-cycle returning a stale count for an 11-line file — a false-demotion source in the same class as the review round's own F1 line-convention bug. `LineCountCacheEntry` now also stores `size`, and a cache hit requires both `mtimeMs` and `size` to match; a shrink/restore cycle always changes size, so this closes the collision with no added I/O (size is already on the same `fs.Stats` the mtime came from).
  - `clients/diagnostic-line-freshness.ts` — `LineCountCacheEntry.size`; `getCachedLineCount` compares both fields for a hit.
