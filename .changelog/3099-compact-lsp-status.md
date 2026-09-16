---
section: Added
---

- **Opt-in compact LSP status line (`ui.compactLspStatus`, `--lens-compact-lsp-status`) (refs #3099)** — the `pi-lens-lsp` footer status can now render one state glyph per group (`LSP ✓` green, `LSP ✗` red, dim `LSP ✗` when nothing is warm) instead of the active server names (#267). Default off: the published string is byte-identical when the flag is unset. Server ids stay reachable through `/lens-tools` and `lens_health`.
