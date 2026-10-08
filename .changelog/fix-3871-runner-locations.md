---
section: Fixed
audience: user
---

- **Linked-worktree test locations (refs #3871)** — Turn-end test failures from linked worktrees now point to the checkout-relative file for pytest, PHPUnit, Mix, and generic text runners, including runs whose config makes the child run below the dispatch root, and PHPUnit, Mix, and generic failures at the session root now carry their `file:line` location too; ambient Python environments (`VIRTUAL_ENV`, `CONDA_PREFIX`, `UV_PROJECT_ENVIRONMENT`) are not borrowed across checkout boundaries, including from another Windows drive, and very long or blank-heavy runner output no longer stalls location parsing.
