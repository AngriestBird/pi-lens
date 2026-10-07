---
section: Removed
audience: internal
---

- **Retired the merge-train warden (closes #4105)** — `merge-train-warden.yml` (cron every 10 minutes), its two scripts, `warden-run-health` and `github-paging` are gone. It only serviced armed auto-merge (update-branch for a BEHIND PR, re-run or cancel of a starved or stalled run) and added `red-ci`/`conflict` labels and comments that no tool read. PRs land through the merge-on-green chain over `ci-verdict`. The `red-ci` and `conflict` labels stay in `.github/labels.yml` (descriptions marked retired) so the label syncer does not strip them from closed PRs.
