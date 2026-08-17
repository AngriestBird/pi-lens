---
section: Security
---

- **A stalled `gh auth token` probe no longer disables zizmor's online audits for the session (closes #1535)** — A timed-out or unspawnable `gh auth token` lookup used to be memoized as "no token" with no TTL, silently turning off zizmor's GitHub-aware audits (`known-vulnerable-actions`, `unpinned-uses`, `impostor-commit`) for the rest of the session while the scan kept reporting success. The lookup now routes through the shared availability policy: only a genuine answer (`gh` ran and returned an exit code, or is proven absent) is cached — a timeout, host stall, or unspawnable probe expires on a cooldown and is retried. Entering offline mode because of a transient failure now also records a degradation, so the gap is visible instead of silent.
