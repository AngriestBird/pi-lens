---
section: Fixed
---

- **Deferred formatting uses bounded concurrency (closes #1387)** — the `agent_end` drain runs at most three formatter subprocesses in flight, applies results and synchronous bookkeeping in admission order with `setImmediate` yields between files, preserves per-file failure isolation, and requeues claimed records that were not started when the ambient turn aborts.
