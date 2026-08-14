---
section: Fixed
---

- **Instance-registry liveness tests no longer depend on arbitrary runner PIDs (refs #1352)** — synthetic dead PIDs are classified through deterministic test seams, preserving coverage of footprint exclusion, registry pruning, and vanished-instance wiring without relying on the CI process table.
