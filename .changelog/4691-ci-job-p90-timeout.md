---
section: Added
audience: internal
---

- Add a nightly warning when a required CI job's p90 runtime over the last 20 master runs passes 70% of its `timeout-minutes` cap. It runs as a step in the daily `untriaged-issues.yml` job, emits one annotation per job, and never gates a PR (#4691).
