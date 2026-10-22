---
section: Fixed
audience: user
---

- **A second session's blocker no longer erases another session's commit-gate blocker.** Under `--lens-guard`, the turn-end record now keeps each session's blocker sections with their owner. A session's write, turn end or fix replaces only its own sections. Another session's section leaves only when a clean check of the whole file re-checks it, or when its file is deleted. Before, once a second session fixed its own blocker, `git commit` ran while the first session's blocker was never re-checked (#4738).
