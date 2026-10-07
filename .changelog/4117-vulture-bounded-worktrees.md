---
section: Fixed
audience: user
---

- **A slow Python dead-code scan no longer holds the end of a turn, and vulture and jscpd leave every linked worktree out of their scan (refs #4117)** — The `vulture` scan at turn end is now awaited inside the turn-end budget like knip's, so a project whose scan takes longer than the budget releases the turn instead of waiting for vulture's own 30 s timeout. The scan finishes in the background, its late result is dropped, and a scan that later times out backs that root off for 30 minutes. `vulture` and `jscpd` now exclude every linked git worktree under the scanned root by the list git keeps, whatever the worktree directory is called, and also when the project ships its own `[tool.vulture]` or jscpd config: the exclusion is merged into the project's own exclude list rather than replacing it. A worktree that cannot be excluded (a comma or glob character in its path, or a config list that cannot be read) is counted in the degradation ledger as `scan-worktree-exclusion-skipped`.
