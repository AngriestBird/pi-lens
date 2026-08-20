---
section: Fixed
---

- **Clean workspace-diagnostics cache entries no longer replay across a
  dependency edit on a cold session** — A clean entry recorded while a
  reverse-dependency index was available now refuses to serve on a later
  session that has none, instead of falling back to mtime-only checking. The
  cache used to trust any clean entry's own mtime alone whenever this
  session's dependency graph wasn't built yet, so a dependency change (or a
  config change that flipped a file from clean to failing) went unnoticed for
  as long as the file's own bytes stayed untouched. Refused entries count
  toward the existing `lsp_workspace_diagnostics_cache_expiry` record in
  `latency.log` (`depIndexColdRefusals`). An entry recorded on an equally cold
  session keeps today's mtime-only behavior — it never claimed more than that
  check can verify.
