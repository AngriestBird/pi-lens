---
section: Fixed
---

- **`no-non-null-assertion` narrows two more idiom shapes** — a `!` guarded
  by an identical truthy ternary condition, or re-asserted on a
  `.filter()`-checked property immediately chained into `.map()`, no longer
  flags. Both exclusions are scoped to the nearest enclosing ternary or
  arrow function and require the same metavariable binding, so a
  differently-bound guard still flags. Pi-lens's own residual drops from 36
  to 27; the rule stays at `warning` pending the tier decision tracked in
  #1818.
