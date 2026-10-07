---
section: Fixed
audience: user
---

- **`read_enclosing`, `read_symbol` and structural analysis no longer fail on bash test commands like `[ a == b ]` (refs #3996)** — The bundled bash grammar imported a function the tree-sitter runtime does not export, so any script with `==` or `!=` in `[ ]` / `[[ ]]` was reported as `tree-sitter failed to parse as bash`, and repeated failures could degrade the runtime until other languages failed with `memory access out of bounds`. The bash grammar now comes from the maintained `tree-sitter-bash` package, an unresolved grammar import is counted and contained like any other wasm trap, and a trap while `read_symbol` or `read_enclosing` extracts callbacks is reported as a wasm runtime failure instead of a raw extractor error.
