---
section: Fixed
---

- **A clean re-answer now clears a cached diagnostics entry** — A
  `workspace/diagnostic` pull returns a project-wide report, but pi-lens read
  only the part covering the files it had just asked about. An explicit
  zero-diagnostic answer for a file served from cache was discarded, so a server
  that re-checked a file and found it clean could not dislodge its stale
  blockers by any means available to a user. Those answers now flow through the
  sweep's ordinary result list, which overwrites the cache entry and clears the
  widget rows.
