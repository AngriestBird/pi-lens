---
section: Fixed
---

- **Remove three real-timer races from tests that only pass under CPU contention (refs #2225, #2235, #2182)** — `safe-spawn.ts`'s cap-then-timeout/cap-then-abort tests raced a real child's stdout against a real 300ms timer (5/8 failures under 8 concurrent runs); they now mock the child so the cap trips before the timeout by construction, in a new `safe-spawn-cap-race.test.ts`. `spawn-timeout-cooldown.test.ts`'s markdownlint-fix guard paired real filesystem I/O with a heavy dynamic import inside vitest's 5000ms default, reproduced as a hard timeout under synthetic load; it now carries a 20s budget. `managed-tool-refresh-strategies.test.ts` had more instances of the dangling-promise-contamination shape #2216 first fixed for one test — a file-wide `vi.setConfig({ testTimeout: 20_000 })` replaces per-test patching. A residual shared-mutable-state race in the same file, independent of any timeout, is left open on #2182.
