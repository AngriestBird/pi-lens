---
section: Fixed
audience: user
---

- **A module changed outside pi no longer leaves its importer's diagnostics stale (refs #4532)** — when a file the diagnosed file imports directly was changed outside pi and no language server held it open, the server kept the old bytes it had read, so `lsp_diagnostics` reported (or missed) errors against the old module on the first call and every call after it. Each direct import no server holds is now compared with the bytes last seen, and a changed one is sent to its servers before the read, so the first call already answers against the new bytes. Each call that sends writes one `lsp_unheld_dependency_changed` row.
