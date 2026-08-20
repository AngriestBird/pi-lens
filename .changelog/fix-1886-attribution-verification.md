---
section: Fixed
---

- **Unverified path guesses remain visible ([refs #1886](https://github.com/apmantza/pi-lens/issues/1886))** —
  a same-named workspace file no longer verifies a tool result when the
  execution target and cwd are unavailable for comparison. The full
  attribution record is retained, lifecycle rollups are tested through
  `session_start` and primary or secondary `session_shutdown`, and the
  session tally remains explicitly best-effort because a crash loses its
  memory-only count.
