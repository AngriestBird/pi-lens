---
section: Added
---

- **`cue vet` auxiliary runner for CUE evaluation errors (closes #1522, refs #1519)** — `cue lsp` reports load and parse errors as you type but deliberately leaves conflicting values and failed constraints to `cue vet`. A new `cue-vet` dispatch runner covers that gap, running alongside the LSP on every `.cue` edit (the same "lsp covers part, a CLI covers the rest" shape as terraform's `lsp, tflint, trivy-config` group). It runs with `-c=false` so an ordinary schema-only file — no concrete data, a common CUE authoring pattern — doesn't fail vet's default concreteness gate; a real type conflict still reports. Verified against a real `cue v0.17.1` binary end to end, including the tool-smoke fixture's binding diagnostic.
