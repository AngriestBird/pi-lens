---
section: Fixed
---

- **Resolve LSP-managed release binaries before PATH (refs #2140)** — Every GitHub-release-managed LSP server (clojure-lsp, cue, deno, expert, gleam, marksman, opengrep, rust-analyzer, taplo, terraform-ls, typos-lsp, zizmor, zls) now checks `~/.pi-lens/bin` before walking bare PATH candidates, same as the fast path PR #2148 already gave the CLI-scan side of opengrep/gitleaks/trivy/govulncheck. A managed binary with no PATH entry no longer ENOENTs a launch candidate before the installer step finds the same binary a moment later. For rust-analyzer and deno, this means a pi-lens-managed copy is now preferred over a developer-toolchain-managed one (rustup, `deno upgrade`) when both are present; the managed copy is kept from drifting too far via the existing 7-day managed-tool refresh cadence.
