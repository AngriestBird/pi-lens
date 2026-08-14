---
section: Fixed
---

- **Recover stale git-guard blocker records (closes #1084)** — Clear persisted blocker content when the last explicitly recorded blocking file is revalidated clean, while retaining fail-closed handling for records without blocker-file provenance.
