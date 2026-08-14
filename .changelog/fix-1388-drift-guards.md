---
section: Fixed
---

- **Prevented consistency drift in language fixtures and extension handling (refs #1388)** — call-graph fixtures now cover every symbol-query language, JS/TS facts share the canonical extension policy, and bash file-access tracking derives source extensions from `KIND_EXTENSIONS`.
