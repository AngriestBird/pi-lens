---
section: Fixed
---

- **Deferred format/autofix drain no longer runs mid-run on auto-retry or overflow-compaction (refs #1654)** — pi's `agent_end` fires on every completion of `_runAgentPrompt`, including a run about to auto-retry or resume after overflow-compaction; pi computes `willRetry` only after emitting `agent_end` and never exposes it to extensions. Running the #1387 deferred-format/autofix drain there could format files the agent was still actively working on between retries, shifting lines under queued work and staling in-flight content bindings (the #1642 harm family). The drain now runs at `agent_settled` — pi's documented once-per-run signal ("no automatic retry, compaction, or queued continuation will run") — with a best-effort, time-boxed safety net at `session_shutdown` so a run that ends without ever settling does not strand queued work forever.
