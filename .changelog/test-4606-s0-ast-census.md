---
section: Changed
audience: internal
---

- **The eviction and container sweeps share one AST census seam (#4606).** `tests/support/ast-census.ts` owns the pre-order walk, the single parse behind it, and the census file list with its `.js`-twin rule; both sweeps keep their own roots and admission tables, so no detector rule and no admission row moves. A new guard classifies every traversal site in the seam and its two consumers, so a second walk (or a second module instance) reds instead of silently duplicating one.
