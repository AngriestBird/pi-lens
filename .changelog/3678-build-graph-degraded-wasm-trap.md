---
section: Fixed
---

- `pi-lens build-graph` now prints a degraded line naming how many files a
  tree-sitter wasm trap cost its symbols, instead of the clean success line.
  The build still exits 0 and the affected files are re-extracted on the next
  build (refs #3678).
