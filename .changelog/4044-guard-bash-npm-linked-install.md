---
section: Changed
audience: internal
---

- `guard-bash` now denies mutating `npm` verbs (`ci`, `install`, `update`, `uninstall`, `prune`, `dedupe`, `rebuild`, `npx npm@… ci`), `--dry-run` or not, where a lane's `node_modules` is a symlink out of the project, and `pr-worktree open` prints the main install's entry count on stderr (#4044).
