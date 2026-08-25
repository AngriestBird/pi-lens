---
section: Fixed
---

- **Decline LSP roots outside the session cwd (refs #2052)** — foreign files now receive an explicit outside-project-root skip and one bounded record per foreign root instead of diagnostics from the wrong project context.

> Refs #2052

