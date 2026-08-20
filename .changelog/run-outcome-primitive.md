---
section: Fixed
---

- **Seven linters no longer report a clean file after a failed run** —
  `markdownlint`, `mypy`, `sqlfluff`, `stylelint`, `swiftlint`, `vale`, and
  `yamllint` read their tool's exit status zero times, so a rejected flag, an
  unreadable config, a crash, or a `SIGKILL` parsed to zero diagnostics and was
  reported as a clean file. All seven now route the spawn through a shared
  `classifyRunOutcome` primitive, return `skipped`, and record one bounded
  `runner-empty-result` row naming the tool, its exit status, and the signal.
  A shared `formatToolFailure` gives every runner one wording and one
  truncation, and `SpawnResult` now carries the signal as a field instead of
  burying it in an error message. Two bugs the same survey found are fixed
  alongside: the degradation ledger appended its repeat count before a second
  truncation at the same bound, so a 200-character reason lost the count; and
  the quarantine file lock required a finite `createdAt` before it would test
  PID liveness, so an owner record without one was never reclaimed and every
  caller burned its full wait.
