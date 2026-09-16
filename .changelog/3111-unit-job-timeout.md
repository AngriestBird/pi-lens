---
section: Changed
---

- **Bound the Unit tests job with `timeout-minutes` (refs #3111)** — `test` (Unit tests) in `.github/workflows/ci.yml` carried no `timeout-minutes`, so a reader that is alive but never drains (e.g. an unbounded stdout stall in the mem-watch wrapper, #3106) could hold the runner for GitHub's 360-minute default; the job now caps at 26 minutes, sized at 2x the measured longest Unit run (12m42s) across 9 successful master runs.
