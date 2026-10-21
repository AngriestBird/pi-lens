---
section: Fixed
audience: user
---

- **Bash writes in a linked worktree of the session repo are analysed again.** An interpreter or `cd`-relative write there is recovered from that checkout's own `git status`, published, and dispatched with LSP, instead of the session root's clean tree reading as "nothing changed"; relative operands now resolve against the command's own `cd` (#2050).
