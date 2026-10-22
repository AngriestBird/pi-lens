---
section: Fixed
audience: internal
---

- The nightly LSP clean-gate now gates the Expert (Elixir) row: its seeded compile error sits under `lib/`, where Mix compiles it, and a readiness rung polls `lsp_diagnostics` to a deadline for a server that publishes only after a save (#3405).
