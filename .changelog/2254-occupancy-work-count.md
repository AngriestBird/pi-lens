---
section: Changed
---

- **Convert the word-index per-edit occupancy guard to a load-invariant work count (refs #2254)** — the per-edit seam's occupancy bound was a wall-clock max-block over a 401-document fixture with `retry: 2`, so it was both flaky and a noisy neighbour in the timing-sensitive test lane. It now asserts the seam's cooperative replacement reads the clock a number of times bounded by the old document's distinct tokens, not by the posting elements it walks, which is deterministic and invariant to runner load. The guard leaves the timing-sensitive lane, and that lane returns to `maxWorkers: 2` now that its one heavy neighbour is gone. The shared `countClockReads` helper moves to `tests/support/perf-harness.ts` so the incremental test and the seam test read one implementation.
