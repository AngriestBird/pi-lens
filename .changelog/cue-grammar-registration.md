---
section: Added
---

- **CUE tree-sitter grammar** — `.cue` files now parse under tree-sitter. No publisher ships a CUE wasm, so pi-lens builds one from a pinned upstream commit and commits it to `vendor/grammars/`; `scripts/check-grammar-provenance.mjs` re-hashes it against the pin in `scripts/grammars.lock.json` on every CI run, and the download path refuses a vendored grammar outright instead of retrying a URL that will never exist. This lands the parser only: no CUE symbol or import queries exist yet, so structural symbol search and import extraction still skip `.cue`, and search falls back to the word index. The query rules are tracked in #1522.
