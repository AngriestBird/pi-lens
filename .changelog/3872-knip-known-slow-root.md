---
section: Fixed
audience: user
---

- A project whose linked worktrees are not gitignored no longer makes every turn end wait the full hook budget on a knip scan that cannot finish in it: a root whose last two scans both outlasted the budget is started but not awaited, and the knip row and a counted `turn-end-knip-nested-worktrees` record name how many worktrees knip walked and how many files with issues were dropped from them. Adding `/.worktrees/` (or your worktree directory) to `.gitignore` removes the cost itself (6 worktrees: 10.9 s to 2.6 s cold, 3.1 s to 0.6 s warm) (#3872).
