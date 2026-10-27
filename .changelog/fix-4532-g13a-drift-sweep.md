---
section: Fixed
audience: user
---

- **`lsp_diagnostics` and `lens_diagnostics source=lsp` read a held file changed outside pi on the first call (refs #4532)** — the tool body now runs the forced document-drift sweep before it answers, so a file the language server already holds and that was copied or written outside pi (a `cp`, a shell redirect) is re-pushed first, and an importer's finding clears on the first call instead of the second. One forced pass checks 64 held documents and re-pushes at most 4; a larger set heals over the next calls.
