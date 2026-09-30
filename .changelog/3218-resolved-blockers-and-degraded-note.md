---
section: Fixed
---

- **Name blockers resolved this turn, and stop claiming a demoted one still blocks (#3218, #3748)** — the turn-end block now says `Resolved this turn: <file> (<n> blocker(s) cleared by the <n>th write)` when a fresh clean dispatch retires an inline blocker, capped at 10 files with `… and N more`; and a stale or demoted advisory no longer ends with the delta-promotion note `new in this edit → blocks in delta mode`.
