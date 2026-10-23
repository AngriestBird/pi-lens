---
section: Fixed
audience: internal
---

- The nightly LSP clean-gate now gates the Expert (Elixir) row. Its seeded compile error moved under `lib/`, where Mix compiles it (the old root-level file was never compiled, which is why the row read as a server limit), and a readiness rung polls `lsp_diagnostics` while Expert activates its project (#3405).
