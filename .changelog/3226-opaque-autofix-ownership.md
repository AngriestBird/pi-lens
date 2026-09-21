---
section: Fixed
---

- **Preserve opaque mutation ownership (refs #3226)** — Opaque bash recovery
  still records freshness and runs analysis, but observed paths no longer
  receive read-guard authorship, autonomous format/autofix, or edit-directed
  blocker/actionable delivery. Explicit native and recognized direct bash writes
  retain their configured writer policy.
