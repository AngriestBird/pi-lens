---
section: Fixed
audience: user
---

- **A symlinked file keeps one footer row after it is formatted or marked** — formatting `AGENTS.md` (a link to `CLAUDE.md`) opened a second footer row under the link's name beside the one the analysis wrote under the file's real path, and a `lens_diagnostic_mark` call typed with the link's name never retired the real file's row. Both now write the row under the file's real path.
