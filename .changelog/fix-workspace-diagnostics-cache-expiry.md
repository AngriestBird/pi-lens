---
section: Fixed
---

- **Stale workspace-diagnostics cache entries now expire** — A cached entry that
  asserts findings and predates the current session start, or that has aged past
  a four-hour in-session ceiling, is dropped at serve time and the file goes back
  through a fresh check. A cache hit used to skip that check, so an entry no
  newer pull re-answered replayed its diagnostics forever, across sessions,
  rendered as current blocking errors. Clean entries keep serving: their only
  claim is "nothing changed", which the existing mtime, dependency, and
  content-hash gates check. Each sweep that expires entries writes one
  `lsp_workspace_diagnostics_cache_expiry` record to `latency.log` with the
  count and the oldest age.
