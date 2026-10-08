---
section: Fixed
audience: user
---

- Relative-path reads, nested codemode reads and pi-lens rewrites (including the structural `ast_grep_replace` apply) now retain their read-guard and mutation bookkeeping across nested calls and conversation moves; a read that errored no longer licenses the next edit, and a read never blocks a whole-package fixer's restore of an agent edit.
