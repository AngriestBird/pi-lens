---
section: Changed
---

- `scripts/ci-verdict.mjs` prints one advisory `MUTATION` line for a PR: the `Mutation diff` comment's survivor count and the head it covers, `STALE` when that is not the PR head, `PENDING` when there is no comment or the job is still running. It never changes an exit code, and a `--watch-open` poll never reads it (an event line does, once). The fixer and reviewer contracts now scope hand mutation to the PR's new guards and have the reviewer triage the comment's survivors instead of re-running the table (closes #3779).
