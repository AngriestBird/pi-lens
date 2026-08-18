---
section: Added
---

- **CUE structural analysis** — `.cue` files now parse under tree-sitter, so symbol search, imports, and the structural runners see them. No publisher ships a CUE wasm, so pi-lens builds one from a pinned upstream commit and commits it to `vendor/grammars/`; `scripts/check-grammar-provenance.mjs` re-hashes it against the pin in `scripts/grammars.lock.json` on every CI run, and the download path refuses a vendored grammar outright instead of retrying a URL that will never exist.
