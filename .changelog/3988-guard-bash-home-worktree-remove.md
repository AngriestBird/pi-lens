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
  denied like the absolute one. A `git worktree remove` path it cannot resolve
  statically (`$(…)`, backticks, `~user`, an unset `$VAR`, a glob, an
  unresolvable `cd`) now fails closed with its own message (closes #3988).
