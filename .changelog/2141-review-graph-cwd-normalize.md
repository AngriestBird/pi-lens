---
section: Fixed
---

- **Normalize review-graph.log's cwd to one form (closes #2141)** — `logReviewGraph` and `logWordIndex` now normalize `cwd` at their single emit seam, so the same project root no longer appears as both `C:\...\pi-free` and `C:/.../pi-free` in the same log.
