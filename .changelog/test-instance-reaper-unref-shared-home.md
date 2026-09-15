---
section: Fixed
---

- **Isolate `instance-reaper-unref` from the run-shared `PI_LENS_HOME` (refs #3050)** — `sweepUntrackedOrphans` takes `<PI_LENS_HOME>/orphan-backstop.lock` and reads the 30-minute `orphan-backstop.json` cooldown stamp before it enumerates anything, so a sibling Vitest fork's real `session_start` (`tests/index-integration.test.ts` arms 37 `scheduleUntrackedOrphanSweep()` timers through `index.js`) left a fresh stamp and the unref test's sweep returned `cooldown` with zero spawns — master 038e28b's only Unit failure. Each case now pins its own `mkdtemp` home, and `#3050`'s detector, which had recorded a two-character body for every declaration with a braced default parameter value and so never saw `sweepUntrackedOrphans`, now finds a body brace past the parameter list.
