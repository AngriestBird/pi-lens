---
section: Changed
audience: user
---

- `latency.log` now carries one `turn_end_test_selection` record per turn that edited files: how many test targets were selected, why the rest were not (no test file, excluded, missing, over the cap), and the count per owning checkout (`.` for the session checkout, `.worktrees/x` for a linked worktree), so a turn that ran 0 tests can be explained after the fact (#3871).
