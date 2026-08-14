---
section: Changed
---

- **Word-index resume stats run through a bounded parallel walk (refs [#1409](https://github.com/apmantza/pi-lens/issues/1409))** — session-start incremental refresh now stats source files with a bounded indexed cursor pool (8 workers over libuv's 4-slot threadpool) instead of serial synchronous calls, while publishing metadata in original walk order so churn classification and rebuild preflight remain deterministic. Per-file stat failures retain the previous absent-file semantics, supersession stops new claims and settles in-flight work, and phase telemetry separates snapshot load, deserialize, source walk, stat walk, refresh reads, and the synchronous snapshot-save span.
