---
section: Added
audience: internal
---

- Add a nightly warning when a required CI job's p90 runtime over the last 20 master runs reaches 70% of its `timeout-minutes` cap. It shares the rule with ci-verdict's per-head "Runtime vs cap" report, reads the required set from branch protection, emits one annotation per job, names every required context it could not measure, and never gates a PR (#4691).
