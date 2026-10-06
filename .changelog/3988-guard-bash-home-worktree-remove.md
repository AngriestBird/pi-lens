---
section: Fixed
audience: internal
---

- `scripts/hooks/guard-bash.mjs` now expands a leading `~`, `$HOME`, or
  `${HOME}` on a `git worktree remove` path before it checks for a
  `node_modules` symlink pointing outside the worktree, so a home-relative
  spelling of the path is denied like the absolute one (refs #3988).
