---
section: Fixed
audience: internal
---

- `scripts/pr-worktree.mjs open` refuses a destination at or inside a registered checkout (symlinks resolved), so a HOME pinned under the source checkout no longer nests a second review tree in it; the refusal exits 2 before any fetch, mkdir or `git worktree add` and names `PI_LENS_WORKTREES_ROOT` (closes #3981).
