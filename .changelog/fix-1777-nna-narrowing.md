---
section: Changed
---

- **Narrow `no-non-null-assertion` false positives (refs #1777)** —
  `$M.get($K)!` guarded by `$M.has($K)` in the same function, and
  `$A.pop()!`/`shift()!` inside a `while`/`for`/`if` whose condition checks
  `$A.length`, no longer fire; both exclusions require the same receiver
  and key/array metavariable binding, so a check on a different key, map,
  or array still flags. The rule stays at `warning` — the re-census showed
  the residual is still idiom-heavy rather than dominated by genuine
  cross-boundary risk, so this is a precision fix, not a tier change. See
  the rule's `note:` for the full four-corpus census.
