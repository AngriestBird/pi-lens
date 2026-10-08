---
section: Fixed
audience: user
---

- **Shared secondary worktree roots now remain visible until every session holding them leaves.** Each session's registry record lists only the roots it registered, so a session ending after a primary reload or a cap eviction can no longer drop a root another live session still serves (#3849).
