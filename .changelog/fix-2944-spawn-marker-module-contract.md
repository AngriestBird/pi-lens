---
section: Fixed
---

- **Anchor the test-runner child on the module its command runs in (refs #2944)** — every runner's spawn-cwd markers must name one of the runner's own manifests or the launcher its command actually invokes; the contract is now derived and tested over the whole runner table, and the stale claim that Maven's `mvn` command anchors on its `mvnw` wrapper is corrected. The Maven anchor itself landed with the #2965 marker-seam fix.
