---
section: Fixed
audience: internal
---

- Scripts that read Vitest console output (the pre-push hook's recorded counts, `lane:check`, `scripts/mutate.mjs`, `scripts/ci-test-diff.mjs`, the Windows failure count, the `ci-verdict` red-row label and the CI classifier) now share one parser, `parseVitestSummary` in `scripts/lib/vitest-summary.mjs`, that strips ANSI, Actions timestamps and CRLF first and reads the run's last `Tests` summary line. `scripts/mutate.mjs --tests` now stops at the next flag and accepts several files. The pre-push record read `passed: 0, failed: 0` for a coloured red run (#4087).
