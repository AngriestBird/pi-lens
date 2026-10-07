---
section: Fixed
audience: internal
---

- **Changelog fragment fast-fail counts only PR-owned additions on stale-base branches (closes #4033)** — CI now compares the PR head from its merge-base with the event base, so fragments added by master after a PR was cut no longer make the one-fragment check fail.
