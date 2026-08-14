---
section: Fixed
---

- **Deferred formatting yields between queued files (closes #1387)** — the `agent_end` drain no longer launches every queued formatter in one `Promise.all` burst or runs all per-file bookkeeping back-to-back; it preserves queue order and per-file failure isolation while yielding with `setImmediate` between files. Investigation found the CPU-bound loop block at `clients/runtime-agent-end.ts:228-352`: batch formatter scheduling plus synchronous result/content bookkeeping, including the `clients/pipeline.ts:1017-1066` formatter invocation and file reread, not a synchronous directory walk.
