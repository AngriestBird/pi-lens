---
section: Fixed
---

- **Hardened codebase-model cache identity (closes #1388)** — persisted models now carry a version and canonical review-graph identity, stale caches invalidate on mismatch, and model file selection uses shared role and artifact filtering.
