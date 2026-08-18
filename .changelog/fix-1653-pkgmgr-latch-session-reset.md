---
section: Fixed
---

- **Package-manager availability latches re-arm at `session_start` (closes #1653)** — `resolveNodePackageManager` keeps one `AvailabilityLatch` per pnpm/yarn/bun/npm in a module-local map, so a genuine "missing" verdict from one session stayed latched into the next: install pnpm mid-day, start a fresh session, pi-lens still reported it missing until a process restart. Same module-local shape as psscriptanalyzer's latches (#1490) and zizmor's `gh auth token` cache (#1535) — `resetDispatchAvailabilityState`'s generation counter never reached it because nothing called the module's own reset hook. `handleSessionStart` now calls `_resetPackageManagerCache()` in its per-session reset block, beside `resetZizmorTokenAvailability()` and `resetPsScriptAnalyzerAvailability()`.
  - `clients/runtime-session.ts` — `handleSessionStart`'s per-session reset block.
  - `clients/package-manager.ts` — `_resetPackageManagerCache`'s doc comment now records it as production wiring, not just a test hook.
  - Review round: making the reset a real production path exposed a latent race in `isAvailable`'s in-flight probe map — its `.finally` deleted the map entry by key rather than by identity, so a pre-reset probe that settled after a new session's own probe for the same manager was already in flight could evict that newer entry and cause a duplicate spawn. Fixed with the same identity guard `resolveMadge` in `dependency-checker.ts` already uses for the equivalent race.
