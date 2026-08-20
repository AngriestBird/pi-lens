---
section: Fixed
---

- **Ignore zero-byte freshness reads (refs #1865)** — Keep live diagnostics visible during truncate-then-write windows and record the observed file size for past-EOF demotions.
