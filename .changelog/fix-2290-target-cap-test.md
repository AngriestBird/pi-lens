---
section: Fixed
---

- **Make the failed-target cap test load-invariant (closes #2290)** — Seed the real `TestRunnerClient` state with deterministic failed results instead of launching 33 child processes, so the cap assertion is independent of batch contention.
