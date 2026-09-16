---
section: Changed
---

- **Bound every remaining workflow job with a measured `timeout-minutes` (refs #3111, closes #3123)** — the ~50 jobs across 18 workflow files left unbounded by #3111's `test` (Unit tests) fix now each carry a `timeout-minutes` sized from the job's own measured history (last 10 successful runs, `~2x max + margin`, floored at 10 minutes), so a stalled-but-alive job can no longer hold a runner for GitHub's 360-minute default; a job with no successful run in the search window (a `pull_request`/`repository_dispatch`-gated job that the master-branch sample structurally excludes, or one that has never once succeeded) gets a stated default with the reason recorded in a YAML comment above the line.
