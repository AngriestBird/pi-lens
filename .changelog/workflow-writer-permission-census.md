---
section: Fixed
audience: internal
---

- Dispatchable workflow jobs are now checked by the write scopes they hold (job over workflow over the repository default): the smoke, rollup, bench, analysis and report jobs are read-only and run on a branch dispatch, while small schedule-or-master writer jobs hold the issue, data-branch, pull-request and code-scanning writes; `scripts/dispatch-safety.mjs` reads the same guard parser.
