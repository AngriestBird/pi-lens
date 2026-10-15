---
section: Fixed
audience: user
---

- **Blockers and the cascade now see Go peers, ambient files and dynamic imports (#4438)** — The inline-blocker sweep demotes an LSP blocker to `[stale — re-run to confirm]` when a Go file of its package changes, when pi-lens recorded a write to a file that feeds the TS/JS global scope (a `.d.ts`, `declare global`, a script) after the verdict, and when the target of an `import("x")` or `require("x")` changes. The cascade checks a Go file's package peers and, for a changed ambient file, the 10 most central JS/TS files, and says when it stopped there. The diagnostics cache announces a dynamic-import target created outside pi-lens. All three read the one implicit-scope test in `clients/lsp/implicit-scope.ts`. An ambient file written by a tool pi-lens never saw still leaves the cache and the sweep stale.
