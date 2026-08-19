---
section: Fixed
---

- **Workspace-diagnostics cache entries now expire instead of serving 28-hour-old
  errors as fresh** — A cached entry that asserts findings and predates the
  current session start, or that has aged past a four-hour in-session ceiling,
  is dropped at serve time and the file goes back through a fresh check. A
  cache hit used to skip that check, so an entry no newer pull re-answered
  replayed its diagnostics forever, across sessions, rendered as current
  blocking errors. Clean entries keep serving: their only claim is "nothing
  changed", which the existing mtime, dependency, and content-hash gates already
  verify. Each sweep that expires entries writes one
  `lsp_workspace_diagnostics_cache_expiry` record to `latency.log` with the
  count and the oldest age.
- **A clean re-answer now clears a cached entry** — A `workspace/diagnostic`
  pull returns a project-wide report, but pi-lens read only the part covering
  the files it had just asked about. An explicit zero-diagnostic answer for a
  file served from cache was discarded, so a server that re-checked a file and
  found it clean could not dislodge its stale blockers by any means available
  to a user. Those answers now flow through the sweep's ordinary result list,
  which overwrites the cache entry and clears the widget rows.
