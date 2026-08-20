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
- **Degradation ledger keeps the repeat count on a long reason** — the count
  suffix was appended before a second truncation at the same bound, so any
  reason at the 200-character limit lost it.
- **Quarantine file lock reclaims a dead owner** — the staleness predicate
  required a finite `createdAt` before it would test PID liveness, so an
  `owner.json` without one was never reclaimed and every caller burned its full
  wait. It now adopts the installer's predicate: a dead PID reclaims regardless
  of `createdAt`, and an aged lock reclaims regardless of the PID.
- **Ledger failure reasons name the signal** — `formatToolFailure` gives every
  runner one wording and one truncation, and `SpawnResult` now carries the
  signal as a field instead of burying it in an error message.
