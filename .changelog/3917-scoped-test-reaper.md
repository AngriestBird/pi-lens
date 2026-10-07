---
section: Fixed
audience: internal
---

- **No test reaches the host process table through the orphan backstop (#3917)** — `index.ts` arms the registry-independent backstop sweep on every real primary `session_start`, and the sweep enumerates the machine's whole process table, so a live foreign orphan whose owner is dead was eligible and the #2042 kill guard failed the file at teardown even though every test passed; eight index-loading files reached the table in a census, and the #3521 fork-tree file was the one that failed. `tests/support/vitest-setup.ts` now answers the backstop's `Name`-filtered table query with an empty table by default; a suite whose subject needs the real table opts in with `vi.unmock("…/process-snapshot.js")`, and a witness drives a real `session_start` and pins that the sweep finishes without a process listing reaching the process boundary.
