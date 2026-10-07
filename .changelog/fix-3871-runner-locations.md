---
section: Fixed
audience: user
---

- **Linked-worktree test locations (refs #3871)** — Turn-end test failures from linked worktrees now point to the checkout-relative file for pytest, PHPUnit, Mix, and generic text runners, including runs whose config makes the child run below the dispatch root; ambient Python environments are not borrowed across checkout boundaries.
