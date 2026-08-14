---
section: Fixed
---

- **Stale advisories are historical, not current blockers (refs #1413)** — Turn-end and async test caches record immutable capture provenance and SHA-256-confirm every affected file at delivery. Changed, legacy, malformed, unreadable, truncated, and superseded findings remain non-blocking historical context; deleted per-file findings disappear, while unchanged findings retain live blocker framing across turn and project-sequence drift. Monotonic async-test generations prevent older batches from overwriting newer results, and MCP and in-process delivery share one classification without changing acknowledgement, one-shot consumption, or commit-gate state.
