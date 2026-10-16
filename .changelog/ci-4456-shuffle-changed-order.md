---
section: Fixed
audience: internal
---

- `Changed test files, alone and shuffled` runs the files a PR adds alone first, before the shuffled starts, so a new witness test no longer sorts past a cap (#4456). The 20-file cap is gone and the time budget is the only bound. The budget is 7 minutes, measured over two real plans that needed about 361 s, and every unproven line names the files it skipped.
