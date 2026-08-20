---
section: Fixed
---

- **Read-guard eviction telemetry is now always on (closes #1913)** — the
  first time a file's read-guard record cap trims in a session, it now emits
  a `read_cap_trimmed` log line (file, evicted count, credit-vs-genuine
  split, raw read count) regardless of `PI_LENS_READ_GUARD_VERBOSE`, so a
  live eviction regression is visible by default instead of only under
  verbose logging. Later trims on the same file keep updating the running
  totals (queryable via `ReadGuard.getTrimStats`, and via the degradation
  ledger's own tally) without flooding the log on every subsequent trim.
