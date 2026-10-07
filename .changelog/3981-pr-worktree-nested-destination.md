---
section: Fixed
audience: internal
---

- `scripts/pr-worktree.mjs open` refuses a destination that is the main checkout or sits inside a registered non-bare checkout (symlinks resolved; an exact hit on another registered tree is left to git), so a HOME pinned under the source checkout no longer nests a second review tree in it; the refusal exits 2 before any fetch, mkdir or `git worktree add` and names `PI_LENS_WORKTREES_ROOT` (closes #3981).
