---
section: Fixed
audience: user
---

- **A file no language server answered for no longer reads as clean on any diagnostics route (#4403)** — a language server turned off in `lsp.disabledServers` now leaves its files unconfirmed on write-time checks, `lsp_diagnostics`, MCP `pilens_diagnostics`, `lsp_navigation workspaceDiagnostics` and `mode=full`, with a note that says it is disabled in config. `lsp_navigation workspaceDiagnostics` no longer returns a clean-looking empty result when the server could not start, and a `mode=full` sweep says the server did not answer instead of blaming a timeout.
