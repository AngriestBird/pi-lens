---
section: Fixed
---

- **Read-guard eviction telemetry is now always on (closes #1913)** — a
  read-guard record-cap trim now emits a bounded `read_cap_trimmed` log line
  (file, evicted count, credit-vs-genuine split, raw read count) regardless
  of `PI_LENS_READ_GUARD_VERBOSE`, so a live eviction regression is visible
  by default instead of only under verbose logging.
