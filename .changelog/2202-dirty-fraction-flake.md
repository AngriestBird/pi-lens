---
section: Fixed
---

- **Record the observed noise behind the dirty-fraction retry (refs #2202)** — the incremental word-index occupancy test already carries `retry: 2` for the dirty-fraction ratio guard. Added the measured evidence to the test comment: isolated runs land at 0.6x-1.1x of the same-run baseline, a synthetic-load run breached the 1.5x bound once at 1.86x and passed on retry at 0.56x, and CI's original failure was a 1.3x breach. The numbers confirm the guard is a load-induced flake, not a real regression in the incremental persist path, so the ratio bound stays unchanged.
