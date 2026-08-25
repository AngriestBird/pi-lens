---
section: Fixed
---

- **Record formatter cache hits (closes #1940)** — Emit `formatter_selected` with `outcome: "hit"`, `reason: "cache"`, and `cached: true` on formatter detection cache hits, providing hit-rate observability with a single denominator in `latency.log`.
