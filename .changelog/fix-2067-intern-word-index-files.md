---
section: Fixed
---

- **Intern word-index posting files (refs #2067)** — Per-edit document replacement now compares shared file identities instead of re-normalizing every posting element; build/refresh telemetry records posting-entry counts and per-edit replacement cost. This is the declared prerequisite for #2069's posting representation work.
