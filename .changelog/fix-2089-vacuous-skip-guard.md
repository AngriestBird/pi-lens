---
section: Fixed
---

- **Tests that could not run reported as passed (closes #2089)** — Thirteen test bodies bare-returned before their first assertion, so Vitest counted them green while they asserted nothing. Each now skips visibly (`it.skipIf` or `ctx.skip(reason)`), the pnpm symlink case runs unguarded on every platform, and a new sweep over the whole `tests/` tree fails on the shape.
