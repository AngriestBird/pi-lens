---
section: Changed
---

- **Record per-cgroup memory/PID/PSI samples and a 200ms watch cadence in CI (refs #2042)** — the Unit-tests job now writes a bounded on-disk tail of `memory.current`/`memory.peak`/`pids.current` and PSI stall totals every 200ms, read back by an `if: always()` step so a killed run still yields its last ~60s of samples; the `Runner capacity` step now resolves its own cgroup for `memory.max` instead of the unpopulated root.
