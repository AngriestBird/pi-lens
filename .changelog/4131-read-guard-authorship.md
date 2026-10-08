---
section: Fixed
audience: user
---

- **The read guard keeps authorship through pi-lens-owned rewrites.** A file the agent wrote stays editable without a re-read when `ast_grep_replace`, `lens_diagnostic_mark`, or an LSP operation rewrites the file that call named and no foreign writer intervened. A file the tool wrote without naming it (a rename's importers, a folder-wide or project-wide apply), a server-initiated `workspace/applyEdit`, or a foreign byte change ends authorship instead, so the next edit asks for one read, and third-party bridge records remain fail-closed (#4131). Authorship survives `/tree`, `/fork` and resume when the branch still shows the write (#3603). Process-bridge writes, observed tool writes and partial bridge reads no longer mark the whole file as freshly read (#3865).
