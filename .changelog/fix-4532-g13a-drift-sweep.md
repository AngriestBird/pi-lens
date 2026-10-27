---
section: Fixed
audience: user
---

- **A held file changed outside pi now reads fresh on the first diagnostics call (refs #4532)** — `lsp_diagnostics`, `lens_diagnostics source=lsp` and `lsp_navigation workspaceDiagnostics` run the forced document-drift sweep before they answer, so a file the language server already holds and that was copied or written outside pi (a `cp`, a shell redirect) is re-pushed first, and an importer's finding clears on the first call instead of the second. The pre-answer pass checks every held document and re-pushes every one that changed; the turn-settle sweep keeps its 64-document and 4-resync pacing. A held file that grew past the LSP sync limit is no longer pushed by a drift resync; its record stays and the next pass retries.
