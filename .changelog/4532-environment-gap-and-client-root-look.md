---
section: Fixed
audience: user
---

- **Environment gaps stop blocking, worktree installs restart servers, adopted shims stay refused.** Environment-gap codes (TS2307 on a Node built-in or a package a `package.json` above the file declares, TS2503 for `NodeJS`, TS2304 and TS2580/TS2591 for `node`'s globals) are demoted to warnings with a label when the file resolves no `node_modules`, on every route (the per-edit check, `lsp_diagnostics` and its cache replays, `lens_diagnostics mode=full` and the cascade), while a path alias or an undeclared import keeps blocking; the out-of-band install look runs at the roots of the live primary clients with each client's spawn epoch, so a `node_modules` symlinked in after the server started restarts it, while an adopted root receives the look and no session bookkeeping; and `launchLSP` resolves a bare server command from PATH **in process** against the cwd the child is spawned with, so a relative `node_modules/.bin` entry (husky's generated `.husky/_/h` exports one for every git hook) can no longer make an adopted root's own shim exec unclassified, and no project-supplied `which` runs (refs #4532).
