---
section: Changed
---

- **Memoize compiled gitignore globs (closes #1976)** — Reuse compiled ignore patterns for each matcher instance, reducing the measured compile count from 500 to ≤6.
