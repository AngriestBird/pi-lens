---
section: Fixed
---

- **The diff mutation lane now reports empty dry runs clearly (closes #2991)** — related Vitest runs use a mutation-only timeout, PR-body tests can inject a prepared test corpus while the real census remains covered, and a failed initial dry run reports that no mutants were evaluated instead of only a generic Stryker status.
