---
section: Fixed
audience: user
---

- **`lsp_navigation workspaceDiagnostics` no longer reads as clean when no language server answered (#4403)** — with a file's language server unable to start, the path form returned an empty result that looked like 0 diagnostics. It now carries `unconfirmed: true` and the same "Primary LSP (…): not available" note `lens_diagnostics source=lsp` gives. A new test drives every diagnostics entry route (write-time dispatch, `lsp_diagnostics` file, batch, directory and primary-only, MCP `pilens_diagnostics`, `lsp_navigation workspaceDiagnostics`, turn-end actionable warnings and `mode=full`) under `--no-opengrep`, `opengrep.enabled=false`, a disabled and a missing language server, and reds when a route starts a different server set or gives a different verdict, or when a new route is added outside the matrix.
