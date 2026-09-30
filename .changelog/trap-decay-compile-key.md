---
section: Fixed
---

- Decay a tree-sitter input's wasm trap count after a successful parse or query compile, scope that decay to the parsing caller so a healthy caller cannot re-arm a trapping one, and key the symbol extractor's query compile per input, so one-off traps no longer disable an input or abort the web-tree-sitter runtime (refs #3678).
