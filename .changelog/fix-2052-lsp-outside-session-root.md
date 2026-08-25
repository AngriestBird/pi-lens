---
section: Fixed
---

- **Decline LSP roots outside every session project root (refs #2052)** — a file outside every initialized session cwd now receives an explicit outside-project-root skip and one bounded record per foreign root, instead of diagnostics computed under the wrong project context. The full sweep carries the skip into the unconfirmed lane, so a declined file is never reported or cached as clean. A process that initializes several project roots keeps serving all of them.

> Refs #2052
