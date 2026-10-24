---
section: Changed
audience: internal
---

- **Manual Windows repeat probe for the server-policy flake.** A `workflow_dispatch`-only job runs one Vitest file up to 30 times on `windows-latest` and reports the pass/fail count and the per-run logs, so the Windows rate of the #4756 root-marker memo flake can be measured without a PR gate (refs #4756).
