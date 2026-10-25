---
section: Fixed
audience: internal
---

- The #3915 loss-notice test in `tests/clients/fix-run-restore.test.ts` waits for the drain's wall-clock bound with the kit's `waitFor` (a real-clock deadline) instead of a 100-turn `setImmediate` spin that ended before the fixer's restore I/O did on a loaded CI host (#4850).
