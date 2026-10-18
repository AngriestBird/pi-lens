---
section: Changed
audience: internal
---

- **The eviction and container sweeps share one AST census seam (#4606).** `tests/support/ast-census.ts` owns the pre-order walk, the single parse behind it, and the census file list with its `.js`-twin rule; both sweeps keep their own roots and admission tables, so no detector rule and no admission row moves. `tests/support/silent-catch-scan.ts` loads the same seam instead of its own copy of the walk. A new guard derives its population from the child-accessor family rather than from known walk spellings, so a second traversal — a `namedChildren().forEach` recursion, a `child(i)`/`childCount()` loop, an accessor bound to a local — reds by file and line, and a second module instance reds too.
