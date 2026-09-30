---
section: Added
---

- Add `scripts/pr-worktree.mjs open` / `close` for review and trailing-commit worktrees, which unlinks only a symlinked `node_modules`, refuses a real directory, then removes the worktree and its local branch (closes #3723).
