---
section: Security
---

- **Guard hardening (refs #1084)** - git commit/push detection now covers normalized wrapper launchers (including path- and PATHEXT-qualified names), shell-escaped verbs, keyword, combined-flag, and continuation forms; shell substitutions are treated as execution even inside text consumers, while literal text remains allowed; bash read and ownership grants use quote-aware tokenization and are recorded only after successful tool results. Stale-record recovery remains deferred.
