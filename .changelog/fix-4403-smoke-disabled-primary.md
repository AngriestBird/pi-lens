---
section: Fixed
audience: internal
---

- **The tool-smoke handshake lane reports an alternate row whose server is missing as unavailable again (#4465)** — since #4411, a touch that no language server answered returns the `primary-unavailable` verdict, not nothing, when a primary is off in `lsp.disabledServers`. Every alternate row disables its default, so the official Docker row failed with "got no warm client" on a runner without the binary instead of skipping. The LSP scripts now share one reader of a touch result: that verdict means "no client ready", and a requested auxiliary counts only while it runs. `bench-lsp` stops reporting every installed server unavailable, and stops timing auxiliaries that never started; the clean-signal probe counts its dirty diagnostics again. The PR install smoke drops its copied official-Docker install step.
