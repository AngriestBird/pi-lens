---
section: Fixed
audience: internal
---

- Two test waits that counted event-loop turns on real I/O now use the kit's `waitFor` with a real-clock deadline: the #3915 loss-notice test in `tests/clients/fix-run-restore.test.ts` (100 turns for the drain's bound, #4850) and `sidecarSettled` in `tests/index-3521-fork-tree-witness.test.ts` (5000 turns for the sidecar write, #4830), which also keeps its test timeout above that deadline. Both ended before the I/O did on a loaded CI host.
