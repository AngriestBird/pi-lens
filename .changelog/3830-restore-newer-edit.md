---
section: Fixed
---

- A whole-package fixer's restore (`cargo clippy --fix`, `dart fix --apply`) no longer overwrites an agent edit of a sibling file that lands while it writes: it runs under pi's queue for that file, after the target's hold is released, and compares bytes before writing.
