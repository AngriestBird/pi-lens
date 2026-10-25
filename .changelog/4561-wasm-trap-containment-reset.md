---
section: Fixed
audience: internal
---

- **Contained-trap tests reset their state per case.** The wasm-trap containment file now clears the review-graph extractor cache and the shared tree-sitter client before each case, so one case's trap charges no longer reach the next (refs #4561).
