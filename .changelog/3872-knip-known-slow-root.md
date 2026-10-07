---
section: Fixed
audience: user
---

- A project whose linked worktrees are not gitignored no longer makes every turn end wait the full hook budget on a knip scan that cannot finish in it: a root whose last scan outlasted the budget is started but not awaited, and the knip row and a counted `turn-end-knip-nested-worktrees` record name how many worktrees knip walked and how many files with issues were dropped from them (#3872).
