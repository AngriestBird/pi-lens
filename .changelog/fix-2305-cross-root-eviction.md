---
section: Fixed
---

- **Make cross-root eviction coverage load-invariant (closes #2305)** — Seed failed-target eviction state through `TestRunnerClient.recordResult` instead of spawning child processes, while retaining global ordering, root-map reacquisition, and telemetry assertions.
