---
section: Fixed
---

- **Bound the dispatch fact store (refs #2240)** — `FactStore`'s per-file records are now capped at 1024 with LRU eviction, so a several-hundred-file batch no longer retains one entry per distinct path until the heap is exhausted. The files being dispatched are pinned, so a background project walk cannot evict facts a live dispatch is still reading.
