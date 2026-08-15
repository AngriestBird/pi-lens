---
section: Fixed
---

- **`ast_grep_replace` now matches `ast_grep_search`'s `hasKind`/`hasDescendantKind` surface (closes #1423)** — `ast_grep_replace`'s `hasKind` param description wrongly said "contain a descendant"; it actually restricts to an **immediate child** (ast-grep default `stopBy: neighbor`), same as `ast_grep_search`. The description now matches the real behavior. `ast_grep_replace` also gained the `hasDescendantKind` param `ast_grep_search` already had — the explicit recursive form (`stopBy: end`) for when the target kind is nested below an immediate child; it's mutually exclusive with `hasKind`, surfaced as a clear synthesis error from both tools. `skills/pi-lens-ast-grep/SKILL.md`'s structural-intent table drops the now-obsolete "replace has no `hasDescendantKind`" divergence warning and documents both params as available on both tools.
