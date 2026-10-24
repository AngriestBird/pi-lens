---
section: Fixed
audience: user
---

- **pyright's interpreter and rust-analyzer's options now reach the server** — pi-lens answered every `workspace/configuration` request from one flat options blob, so pyright (which asks for its `python`, `python.analysis` and `pyright` sections) and rust-analyzer (which asks for `rust-analyzer`) were told "no settings" and ran on defaults, ignoring the detected project interpreter and any `lsp.serverOverrides` options for rust. pyright now gets the interpreter under `python.pythonPath` and open-files mode under `python.analysis.diagnosticMode`, and a real pyright resolves a package that only the project interpreter carries. rust-analyzer's `rust-analyzer` request is answered from its options, user overrides included. Overrides for pyright and basedpyright are written under their section names (for example `python.analysis.typeCheckingMode`); see `docs/configuration.md`. rust-analyzer's own startup behaviour was not measured against a real binary.
