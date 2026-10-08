---
section: Fixed
audience: user
---

- **Read evidence now survives relative paths, nested codemode calls and conversation moves**: relative-path reads, nested reads and pi-lens rewrites (including the structural `ast_grep_replace` apply) keep their read-guard and mutation bookkeeping across `/clone`, `/fork`, `/tree` and `/reload`; a read that errored, or that another extension blocked, no longer licenses an edit later in the same run, and a read never blocks a whole-package fixer's restore of an agent edit.
