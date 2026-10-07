---
section: Fixed
audience: internal
---

- `scripts/hooks/guard-bash.mjs` resolves every path argument through one
  resolver: `~`, `$HOME`, `${HOME}`, `$VAR` and `$PWD` are expanded and a
  relative path resolves against the command's effective cwd (a preceding
  `cd`, `git -C`, else the hook payload's cwd) before the `git worktree
  remove` node_modules-symlink check, the `/tmp` checkout rules, `mktemp -d`
  and the `node` probe rule run, so a shell-expanded or relative spelling is
  denied like the absolute one; a `..` after a symlink is resolved the way
  the kernel does. A `git worktree remove` path it cannot resolve statically
  (`$(…)`, backticks, `~user`, an unset `$VAR`, a glob, an unresolvable
  `cd`) now fails closed with its own message. A command holding a `$(…)` is
  judged with its output both empty and unknown, so `git $(:) stash` and
  `HUSKY=0 git commit` stay denied (closes #3988).
