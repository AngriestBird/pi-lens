---
section: Fixed
audience: user
---

- **Files written by tools other than bash now get diagnostics (#4732)** — A file another extension's tool, an MCP tool routed through pi, or a codemode script writes without naming it is found by the same git diff an opaque bash command gets, published to the language servers and dispatched. pi's read-only and structured built-ins and pi-lens's own tools are not diffed and cost nothing; a captured call costs two `git status` children. A call pi-lens cannot diff (no tool-call id, or git could not answer) is named once per session as `opaque-capture-refused`.
