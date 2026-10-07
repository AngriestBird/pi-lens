---
section: Fixed
audience: internal
---

- **Nightly Stryker no longer dies in its initial test run (#4092)** — both shards of run 37629970371 ran 123 test files (the "47-test cap" exempted every test file changed in the window) and Stryker's 5-minute `dryRunTimeoutMinutes` fired before any mutant was evaluated; the same selection measures 358 s on 4 cores and 449 s on 2. The driver now fits the kept tests into 240 s of estimated test time (per-test seconds from each coverage probe, own tests probed first, a test with no timing costed at the measured p95 of 12 s) in place of the count cap, and `stryker.config.mjs` sets `dryRunTimeoutMinutes` to 10. A run that still outlasts it is a named `dry-run-timeout` shard outcome in the combined report and the tracking issue's status line, recognised only from the logger's own line, not from vitest output that quotes it. Stryker's in-place mode no longer writes `// @ts-nocheck` into every tracked file (`disableTypeChecks: false`), which had failed `tests/scripts/mutate.test.ts` in the initial run (it refuses a dirty tree).
