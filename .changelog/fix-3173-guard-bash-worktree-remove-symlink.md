---
section: Fixed
---

- **`guard-bash` refuses `git worktree remove` on a tree whose `node_modules` is a symlink into another checkout (refs #3173)** — twice on 2026-09-16 a fixer removed a worktree whose `node_modules` was symlinked to the shared checkout (the fixer playbook's own speed convention), and git followed the link and emptied the shared install, breaking every other agent building or testing in that window. The PreToolUse hook now denies (exit 2) ANY `git worktree remove <tree>` — force or not — when `<tree>` is a real linked git worktree and its `node_modules` entry is a symlink whose target resolves outside `<tree>`; the stderr note names the fix (`rm <tree>/node_modules`, then retry). A path that does not exist, is not a git worktree, or whose `node_modules` is a real directory (or a symlink that stays inside the worktree) is left to git.
