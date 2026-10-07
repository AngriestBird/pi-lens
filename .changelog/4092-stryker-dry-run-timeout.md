---
section: Fixed
audience: internal
---

- **Nightly Stryker no longer dies in its initial test run (#4092)** — both shards of run 37629970371 ran 123 test files (the "47-test cap" exempted every test file changed in the window) and Stryker's 5-minute `dryRunTimeoutMinutes` fired before any mutant was evaluated; the same selection measures 358 s on 4 cores and 449 s on 2. The driver now also fits the kept tests into 240 s of estimated test time, taken from the seconds each coverage probe measured, and `stryker.config.mjs` sets `dryRunTimeoutMinutes` to 10. A run that still outlasts it is a named `dry-run-timeout` shard outcome in the combined report and the tracking issue's status line, not a generic failure.
