---
section: Changed
audience: user
---

- **Files whose language server is in `lsp.disabledServers` now read as unconfirmed (#4403)** — every diagnostics route (write-time, `lsp_diagnostics`, MCP `pilens_diagnostics`, `lsp_navigation workspaceDiagnostics` and `mode=full`) says so in one note. A `mode=full` sweep whose language server could not start now says that too, not that a check timed out.
