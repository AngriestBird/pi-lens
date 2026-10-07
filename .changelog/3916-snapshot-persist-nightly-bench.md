---
section: Changed
audience: internal
---

- **The nightly `tool-smoke` workflow now runs the snapshot-persist bench and reds when the worker persist's RSS jump drifts back toward the cloned shape (closes #3916, recurrence of #3789)** — a new `snapshot-persist-bench` job runs `scripts/bench-snapshot-persist.mjs` five times as independent invocations, and `scripts/check-snapshot-persist-ratio.mjs` compares the median first-persist worker/sync RSS ratio (it also logs the min and max) with a provisional threshold of 1.95, so one noisy persist cannot decide a night. A median above the threshold, or an unusable measurement, fails the job and files or refreshes one `nightly-drift` tracking issue through `scripts/upsert-tracking-issue.mjs`; a clean night closes it. The threshold sits between the fixed tree (1.69-1.83 over 11 local runs) and the cloning tree (2.10-2.37 over 9) and is re-calibrated after 7 hosted nights; raw local reports are in `tests/fixtures/snapshot-persist-nightly-calibration.json`.
