---
section: Fixed
---

- Fixed `tests/index-vanished-instance-wiring.test.ts` reddening in the CI Unit
  lane on unrelated pull-request heads. The test drove the run-shared
  `PI_LENS_HOME` registry, so the reaper's best-effort prune had to win a 500 ms
  `withInstanceRegistryLock` deadline against every other concurrently running
  test file; losing it is silent, left the seeded dead-pid entry in place, and
  leaked it into the next case. Each case now runs against its own
  `PI_LENS_HOME` (refs #3042).
