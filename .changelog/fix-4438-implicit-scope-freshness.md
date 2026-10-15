---
section: Fixed
audience: user
---

- **Blockers and the cascade now see Go peers, ambient files and dynamic imports (#4438)** — The inline-blocker sweep demotes an LSP blocker to `[stale — re-run to confirm]` when the target of an `import("x")` or `require("x")` changes, or when pi-lens records a write, under the session root and after the verdict, to a same-package Go file known to be in the host build (test files excluded; a build constraint it cannot evaluate is no evidence) or to a file that feeds the TS/JS global scope (a `.d.ts`, `declare global`, a script). A file whose role cannot be read (deleted, over the LSP sync limits, unparsable) never demotes. The cascade checks a Go file's package peers and, for a changed ambient file, the 10 most central JS/TS files, and says when it stopped there. The diagnostics cache announces a dynamic-import target created outside pi-lens. All three read the one implicit-scope test in `clients/lsp/implicit-scope.ts`.
