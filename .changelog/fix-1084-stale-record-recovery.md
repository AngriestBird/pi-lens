---
section: Fixed
---

- **Recover stale git-guard blocker records (closes #1084)** — Clear persisted blocker content only when complete, well-typed blocker-file provenance proves the last represented blocker was revalidated clean; incomplete or forged provenance remains blocked.
