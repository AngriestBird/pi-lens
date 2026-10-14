---
section: Fixed
audience: user
---

- **A file no language server answered for no longer reads as clean on any diagnostics route (#4403)** — a language server turned off in `lsp.disabledServers` now leaves its files unconfirmed on write-time checks, `lsp_diagnostics`, MCP `pilens_diagnostics`, `lsp_navigation workspaceDiagnostics` and `mode=full`, and each says it is disabled in config. Write-time checks give one such note per server per session, and a later write of an unchecked file prints a one-line "unconfirmed" status naming the cause instead of "clean". `lsp_navigation workspaceDiagnostics` no longer returns a clean-looking empty result when no server answered, and a `mode=full` sweep says the server did not answer instead of blaming a timeout. The same holds when a disabled server's fallback (deno for `typescript`, for example) cannot start. Cross-file checks name such a server once per session instead of listing each importing file as inconclusive, and `lsp_navigation` hover and documentSymbol say the server is disabled instead of suggesting an install.
