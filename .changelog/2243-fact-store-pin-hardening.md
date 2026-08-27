---
section: Fixed
---

- **Harden the dispatch fact-store pin against eviction (refs #2240)** — the debounced ast-grep warning scan is a dispatch entry point, but it never pinned its file or re-derived content, so a project walk in its 2-second window could evict `file.content` and make inline `pi-lens-ignore` suppressions silently stop applying. The scan now pins and re-derives like every other dispatch caller. The pin is also released at dispatch completion, so the pin set tracks dispatches actually in flight rather than the last 16 files touched, and the first capacity eviction per session now records one bounded degradation stamped with the evicted path.
