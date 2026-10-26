---
section: Fixed
audience: internal
---

- **Path-containment ratchet: a hand-rolled `..` test over a `path.relative` result now reds (refs #2556)** — `tests/config/path-containment-sweep.test.ts` admits containment only through `clients/path-utils.ts` (`isUnderDir`, `isWithinForm`, the home-ceiling predicate) across the runtime trees, `scripts/` and `tests/`; the 42 remaining sites are baseline rows with reasons, every comparison and call spelling is read rather than a list of methods, and the detector's state table plants the #4878 F1 spelling that failed 26 `Unit tests Windows` cells.
