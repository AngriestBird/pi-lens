---
section: Security
---

- **Guard hardening (refs #1084)** — git commit/push detection now covers wrapper, launcher, keyword, combined-flag, and continuation forms; bash read and ownership grants use quote-aware tokenization and are recorded only after successful tool results. Stale-record recovery remains deferred.
