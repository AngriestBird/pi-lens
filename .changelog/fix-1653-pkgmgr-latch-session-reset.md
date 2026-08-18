---
section: Fixed
---

- **Package-manager availability latches re-arm at `session_start` (refs #1653)** — `resolveNodePackageManager` keeps one `AvailabilityLatch` per pnpm/yarn/bun/npm in a module-local map, so a genuine "missing" verdict from one session stayed latched into the next: install pnpm mid-day, start a fresh session, pi-lens still reported it missing until a process restart. Same module-local shape as psscriptanalyzer's latches (#1490) and zizmor's `gh auth token` cache (#1535) — `resetDispatchAvailabilityState`'s generation counter never reached it because nothing called the module's own reset hook. `handleSessionStart` now calls `_resetPackageManagerCache()` in its per-session reset block, beside `resetZizmorTokenAvailability()` and `resetPsScriptAnalyzerAvailability()`.
  - `clients/runtime-session.ts` — `handleSessionStart`'s per-session reset block.
  - `clients/package-manager.ts` — `_resetPackageManagerCache`'s doc comment now records it as production wiring, not just a test hook.
