---
section: Fixed
---

- **The turn-end log no longer prints `(0ms)` for a run it never timed (closes #1479)** — `(0ms)` was the string for a genuinely sub-millisecond run *and* for one nobody measured: a JSON payload with no suite timestamps, a pytest or ExUnit or PHPUnit summary the parser could not read, a runner error, or nothing run at all. A reader could not tell "measured 0" from "unmeasured", which is the confusion #1452 was reported for in the first place. `TestResult.duration` is now absent when the run was not measured — a present `0` means a real reading, because pytest does print `in 0.00s` — and the turn-end line renders `(unmeasured)` for the absent case. The agent-facing `formatResult` string is unchanged.
