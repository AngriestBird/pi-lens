---
section: Fixed
audience: internal
---

- `Changed test files, alone and shuffled` runs the files a PR adds alone first, ahead of the 20-file cap and the time budget, so a new witness test no longer sorts past them (#4456). The budget is 7 minutes, measured over two real plans that needed about 361 s, and every unproven line names the files it skipped.
