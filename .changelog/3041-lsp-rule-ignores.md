---
section: Fixed
---

- **Honor a rule's own `ignores` paths over LSP (refs #3041)** — `lens_diagnostics` with `source: "lsp"` or `mode: "full"` no longer re-surfaces ast-grep findings on paths the rule's own YAML carves out, and a stored disposition now matches an auxiliary finding in `mode: "full"`.
