---
section: Fixed
---

- **npm-global tool discovery now flags a stalled package-manager probe as transient (refs #1585)** — `isAvailable`'s bare boolean return could not tell a genuine "pnpm not installed" from a `where`/`which pnpm` probe that stalled, so `allAvailableGlobalBinDirs` silently dropped pnpm's global bin dir with no way to warn its caller. `findNpmGlobalToolPath`'s existing `onTransient` callback (from #1569) now fires for this case too, so `getToolPath` no longer caches a degraded npm-global selection untainted for the full 24h TTL.
