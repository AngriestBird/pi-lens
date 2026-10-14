---
section: Fixed
audience: user
---

- **An explicit LSP check no longer starts Opengrep when it is switched off (closes #4323)** — `lens_diagnostics source=lsp` in pi, `pilens_diagnostics` over MCP and `lsp_navigation workspaceDiagnostics` started the Opengrep security scanner for an all-server check even with `--no-opengrep` or `opengrep.enabled=false` in `~/.pi-lens/config.json`. They now leave every auxiliary scanner the configuration switches off unstarted, as the write-time check and `pilens_analyze` already did, for a single file, a batch, a directory and the primary-only fallback. A batch cached before the switch, or by a `mode=full` sweep, is not served to the narrower check, and a switched-off scanner's findings are not retired by a check that never ran it.
