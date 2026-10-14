---
section: Added
audience: internal
---

- Hot-path latency lane (#4363). `.github/workflows/hot-path-latency.yml` times `session_start`, `dispatchLint` and the diagnostics-cache replay 15 times on the PR head and on its merge base, and reports a bootstrapped interval per metric. It fails only when a metric is significantly slower and at least 1.25x and 5 ms above the base. It is advisory until 10 consecutive master push runs are green.
