---
section: Fixed
---

- **Re-resolve a runner-detection alias probed before its symlink existed (closes #2077)** — `TestRunnerClient` no longer memoizes a project root whose canonicalization failed, so an alias first probed while it was still missing now converges to the real root's runner verdict on the next probe instead of serving the fallback key's stale "no runner" answer for the client's whole life. Resolved spellings are memoized exactly as before, so the hot path is unchanged.
