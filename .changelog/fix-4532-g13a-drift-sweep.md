---
section: Fixed
audience: user
---

- **A held file changed outside pi now reads fresh on the first diagnostics call (refs #4532)** — `lsp_diagnostics`, `lens_diagnostics source=lsp` and `lsp_navigation workspaceDiagnostics` run the forced document-drift sweep before they answer, so a file the language server already holds and that was copied or written outside pi (a `cp`, a shell redirect) is re-pushed first, and an importer's finding clears on the first call instead of the second. One forced pass checks 64 held documents and re-pushes at most 4; a larger set heals over the next calls.
