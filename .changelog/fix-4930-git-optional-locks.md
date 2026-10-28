---
section: Fixed
audience: user
---

- **A pi-lens status read no longer leaves `.git/index.lock` behind, so `git add` keeps working (#4930)** — the spawn seam now defaults `GIT_OPTIONAL_LOCKS=0` for every child, so the background `git status` reads skip the opportunistic index refresh whose lock a timeout or host exit could orphan; a caller `env` override still wins, and an exported `GIT_OPTIONAL_LOCKS` in your shell does not undo the default.
