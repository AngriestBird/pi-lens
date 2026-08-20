---
section: Fixed
---

- **`no-unknown-returns` drops its callback/type-alias arm** — a
  `function_type` (`(x: T) => R`) is a type-position annotation, and a
  callback contract that returns `unknown` is legitimate, unlike a real
  function whose value-position return skipped parsing at a boundary.
  Dropping that arm takes pi-lens's own `clients/` + `index.ts` from 21 hits
  to 9 (#1824).
