---
section: Added
---

- **Quick-mode session_start now logs which steps it skipped (closes #1911)** — quick mode silently skipped slow tool probes, language profiling, preinstall, startup scans, and the error-debt baseline, with no record either way. `session_start` now emits one bounded `session_start_skipped_steps` latency record naming the skipped step set, so a reader can tell "quick mode correctly skipped these" from "the probes silently never ran".
