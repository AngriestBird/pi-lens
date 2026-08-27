---
section: Fixed
---

- **Read-guard eviction paths now leave a trace (#1918)** — Whole-file eviction (file cap, idle timeout, external-delete cleanup) and the per-file edits-cap trim each emit a bounded, always-on `read-guard.log` record naming the file and which path evicted it, closing the gap #1915 left after fixing the record-cap path.
