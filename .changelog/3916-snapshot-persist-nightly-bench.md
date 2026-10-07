---
section: Changed
audience: internal
---

- **The nightly `tool-smoke` workflow now runs the snapshot-persist bench and reds when the worker persist's RSS jump drifts back toward the cloned shape (closes #3916, recurrence of #3789)** — a new `snapshot-persist-bench` job runs `scripts/bench-snapshot-persist.mjs`, and `scripts/check-snapshot-persist-ratio.mjs` compares the worker's first-persist RSS jump with the synchronous path's from the same run. A ratio above 1.95 fails the job and files or refreshes one `nightly-drift` tracking issue through `scripts/upsert-tracking-issue.mjs`; a clean night closes it. The threshold sits between the fixed tree (1.69-1.83 over 11 runs) and the cloning tree (2.10-2.37 over 9 runs); raw reports are in `tests/fixtures/snapshot-persist-nightly-calibration.json`.
