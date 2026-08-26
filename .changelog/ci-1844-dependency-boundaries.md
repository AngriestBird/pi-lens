---
section: Changed
---

- **Enforce client dependency boundaries and cycles in CI (refs #1844)** — dependency-cruiser now rejects client import cycles, declared leaf imports, and unapproved additions to the session-start eager graph.
