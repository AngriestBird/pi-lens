---
section: Fixed
---

- **Test-runner results report a real duration and a real skip count (closes #1452)** — Every vitest and jest run logged `(0ms)`: `parseJsonTestOutput` hardcoded `duration: 0` and read `numSkippedTests`, a field neither reporter emits, so a file with skipped tests also always reported 0 skipped. Duration now comes from the per-suite `startTime`/`endTime` the reporters do emit (wall-clock span across suites, falling back to summed per-assertion durations), and skips come from `numPendingTests` + `numTodoTests`. PHPUnit's own `Time:` summary line — both the `00:00.123` clock form and the legacy `1.23 seconds` / `123 ms` forms — is parsed instead of discarded. An unparseable summary reports no duration at all rather than a wrong figure (see #1479 — this sentence read "still reports 0" until that landed, and both entries are still unreleased, so one release's notes would otherwise have contradicted the other).
