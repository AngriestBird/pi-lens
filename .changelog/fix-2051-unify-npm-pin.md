---
section: Changed
---

- **Unify the pinned npm version across workflows (#2051)** — ci.yml and release.yml both pin npm 11.18.0 so a single lockfile-writer version governs CI and release installs.
