---
section: Fixed
---

- **`require-safety-comment-for-as-unknown-as`'s `SAFETY:` valve no longer exempts every later cast in the same block (closes #1834)** — the backward comment scan now stops at the first non-comment sibling instead of walking unbounded to the top of the block.
