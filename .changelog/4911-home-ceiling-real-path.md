---
section: Fixed
audience: user
---

- **The home-folder ceiling holds when HOME or the project is reached through a link (#4911)** — The startup scan, the session snapshot root, the cheap project scan, the heavyweight analyzers, jscpd, the word index, the review graph, the LSP workspace sweep, the TypeScript server lookup, project-local binary lookup, `ast_grep_search` and `lens_diagnostics` compare the home folder and the root by real path. A symlinked or junctioned `HOME` (for example `/home` linked to `/var/home`), or a root spelled through such a link, no longer lets a scan walk the whole home tree.
