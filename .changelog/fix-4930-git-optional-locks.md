---
section: Fixed
audience: user
---

- **A pi-lens status read no longer leaves `.git/index.lock` behind, so `git add` keeps working (#4930)** — the spawn seam now defaults `GIT_OPTIONAL_LOCKS=0` for every child, so the background `git status` reads skip the opportunistic index refresh whose lock a timeout or host exit could orphan; an exported `GIT_OPTIONAL_LOCKS` in your shell does not undo it for pi-lens's own git status reads, while a runner that passes its own environment keeps your value. On a checkout whose index is stat-dirty, each status read now re-hashes the dirty files until your own git command refreshes the index.
