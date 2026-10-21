---
section: Fixed
audience: user
---

- **Open documents resync after `git stash`, `git checkout .` or `git restore`.** A bash command that discards working-tree changes without moving HEAD now resyncs the files it reverted before the tool result returns, so diagnostics no longer describe the discarded edits (#4502).
