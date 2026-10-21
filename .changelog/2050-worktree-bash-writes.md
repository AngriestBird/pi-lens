---
section: Fixed
audience: user
---

- **Bash writes in a linked worktree of the session repo are analysed again.** An interpreter or `cd`-relative write there is recovered from that checkout's own `git status`, published, and dispatched with LSP, instead of the session root's clean tree reading as "nothing changed"; relative operands now resolve against the command's own `cd`, and a worktree nested under an ignored directory or reached through a symlink is judged by its own checkout (#2050).
