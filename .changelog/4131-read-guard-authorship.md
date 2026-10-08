---
section: Fixed
audience: user
---

- **The read guard keeps authorship through pi-lens-owned rewrites.** A file the agent wrote stays editable without a re-read when `ast_grep_replace`, `lens_diagnostic_mark`, or LSP rewrites it without a foreign writer; a foreign change still ends authorship and third-party bridge records remain fail-closed (#4131). Authorship survives `/tree`, `/fork` and resume when the branch still shows the write (#3603). Process-bridge writes, observed tool writes and partial bridge reads no longer mark the whole file as freshly read (#3865).
