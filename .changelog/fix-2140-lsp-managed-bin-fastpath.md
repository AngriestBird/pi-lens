---
section: Fixed
---

- **Resolve LSP-managed release binaries before PATH (refs #2140)** — Opengrep, Marksman, typos-lsp, and zizmor's LSP launch now check `~/.pi-lens/bin` before walking bare PATH candidates, same as the fast path PR #2148 already gave the CLI-scan side of these tools. A managed binary with no PATH entry no longer ENOENTs a launch candidate before the installer step finds the same binary a moment later.
