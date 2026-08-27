---
section: Fixed
---

- **Move the dirty-fraction word-index guard off wall clock (refs #2202)** — the incremental word-index occupancy test asserted a same-run timing ratio (`dirty=750 ms < fullMs * 1.5`). Review replicated it 20x under 57-94% CPU load and measured a 0.436x-3.863x spread, wider than the 2x regression the guard exists to catch, and found `retry: 2` only escaped a calibrated 2x-work injection about two-thirds of the time. `serializeWordIndex` now records, per call, how many tokens it re-flattened and whether it took the incremental or full-rebuild path (`getLastWordIndexSerializeWork`, test-only). The guard asserts on that count directly: no timer, no retry, no runner-load dependence, and it fails deterministically on a synthetic work-doubling regression.
