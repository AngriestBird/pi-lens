---
section: Changed
audience: internal
---

- **Manual Windows repeat probe for the server-policy flake.** A `workflow_dispatch`-only job runs one Vitest file up to 30 times on `windows-latest` and reports the pass/fail count and the per-run logs, so the Windows rate of the #4756 root-marker memo flake can be measured without a PR gate. The PR-body workflow-run lint now also accepts a push-run URL naming an added workflow, which cannot be dispatched from its branch, and an unreadable merge base no longer reads as an added file (refs #4756).
