---
section: Fixed
audience: user
---

- **Name the prompt-cache misses pi-lens causes, and stop losing real expiry to a long tool result.** `cache_usage` now reports `tool-set-changed` and `system-prompt-changed` from the unbounded ordered system-message set, measures a miss against the last healthy read, re-baselines when the provider served a smaller prefix without re-writing it (so a compaction or a model switch stops reading as a miss), reads `ttl-expired` across an ordinary 20,000-character message, and records one `prompt-cache-miss-unexplained` degradation row on a session's second unexplained miss — the first stays silent and later misses only raise the count (#4687).
