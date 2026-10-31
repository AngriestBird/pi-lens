---
section: Fixed
audience: user
---

- **A second session's commit no longer writes the first session's blockers into its own record**: with `--lens-guard`, a commit by a concurrent session in another repository that picked up the first session's settled collect-later blocker recorded it in its own tree's commit-gate record under the first session's id, so every later commit there was refused `session_mismatch` for a file it did not own. The gate now persists only the committing session's own blockers; the other session's blocker still gates its own tree (#5048).
