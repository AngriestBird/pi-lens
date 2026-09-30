---
section: Fixed
---

- Decay a tree-sitter input's wasm trap count after a successful parse or query compile, and key the symbol extractor's query compile per input, so one-off traps no longer disable an input for the process (refs #3678).
