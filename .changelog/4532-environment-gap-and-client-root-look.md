---
section: Fixed
audience: user
---

- **A session now registers one workspace root instead of a root per edited directory, and an install in a linked worktree restarts that worktree's language server.** TS2307 on a `node:` or bare specifier, TS2503 for `NodeJS` and TS2304 for `node`'s globals are demoted to warnings with a label when the file resolves no `node_modules`; the `tool_call` config init registers the nearest `.pi-lens.json` owner (or the analysis root, so a linked worktree stays its own workspace) instead of `path.dirname(filePath)`, so 200 edited directories no longer evict the project root and its `lsp.disabledServers` denial; and the out-of-band install look runs at the roots of the live primary clients with each client's spawn epoch, so a `node_modules` symlinked in after the server started restarts it (refs #4532, closes #2657).
