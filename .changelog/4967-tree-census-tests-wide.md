---
section: Fixed
audience: internal
---

- The tree-walk timeout census (`tests/config/tree-census-timeout.test.ts`) now scans every test under `tests/`, not only `tests/config`, so a tree walk without a timeout budget reds wherever it sits. The 87 refused members that predate the widening are admitted by name in `tests/config/tree-census-timeout.baseline.json`, each with a reason. (refs #4967)
