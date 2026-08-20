---
section: Fixed
---

- **Resource sampling distinguishes failed process-table queries from empty samples (closes #1863)** — failed or timed-out Windows and POSIX resource queries now remain unknown, with bounded query-specific degradation telemetry, instead of being treated as clean zero-sample results.
