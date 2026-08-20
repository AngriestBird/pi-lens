---
section: Fixed
---

- **Project snapshot misses now name the rejecting gate (refs #1858)** — session-start diagnostics distinguish an absent body, stale meta gate, invalid body, and sequence-stale snapshot instead of reporting every null load as `missing`.
