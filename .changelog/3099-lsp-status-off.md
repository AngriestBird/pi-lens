---
section: Added
---

- **Opt-in off mode for the LSP status line (`ui.hideLspStatus`, `--lens-hide-lsp-status`) (closes #3099)** — the `pi-lens-lsp` footer status can now be suppressed entirely: `updateLspStatus` publishes `undefined` instead of any text, so a host that renders extension statuses stops showing the key at all. Outranks `ui.compactLspStatus` when both are set (nothing to render compactly once the key itself is gone). Default off: unset, the published string is unchanged. Server ids stay reachable through `/lens-tools` and `lens_health`.
