---
section: Added
---

- **Prompt-cache misses now say why, and mixed injections split by source (refs #1071)** — a `cache_usage` record carries `interTurnGapMs` and a `cacheMissCause` verdict of `ttl-expired`, `prefix-broke`, `partial-eviction`, or `unknown`, so the dominant cache cost is readable from `latency.log` instead of reconstructed by hand-joining timestamps. A `cache_context` record splits a mixed injection payload by contributing source, with per-source message count, characters, bytes, and an estimated token count. Token figures use a documented four-chars-per-token estimate and are never presented as provider-measured. The TTL threshold defaults to 60s and is overridable via `PI_LENS_PROVIDER_CACHE_TTL_MS`.
