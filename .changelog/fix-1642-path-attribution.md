---
section: Fixed
---

- **A gitignored worktree edit could dirty the parent checkout (refs #1642)** — `tool_result` re-derived a file's path from its own relative diff metadata instead of trusting the target `tool_call` had already resolved and skipped, so a worktree edit collapsed onto a same-relative-path file in the parent checkout. The deferred-format staleness fallback then formatted that wrong file. `tool_call` now records its canonical resolved path by tool-call identity; `tool_result` uses that recorded target instead of re-deriving one, and refuses (logging a `path_attribution_refused` record) when a skipped call's paired result would otherwise resolve somewhere else. The staleness fallback also now requires the queued record's origin cwd to match the claiming session's before treating it as a recoverable orphan — a mismatched-origin record is dropped and logged, never formatted.
