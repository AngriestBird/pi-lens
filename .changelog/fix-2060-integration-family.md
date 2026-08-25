---
section: Fixed
---

- **Cover the whole failed-Git-integration family.** `git pull`, `git revert`, and `git am` now join merge, rebase, and cherry-pick when opaque recovery drops clean incoming index paths. Truncated `git status` output fails closed, and an undocumented porcelain status pair keeps its path instead of voiding recovery for every other file in the command.
