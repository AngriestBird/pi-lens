---
section: Fixed
audience: internal
---

- The lockfile-completeness npm-9 rewrite case runs real npm on rolldown's closure from the repo lock instead of all ~450 packages, and its budgets follow the lane's test-timeout scale with the gate's kill below the case budget, so a slow cold-cache runner no longer times it out (closes #4936).
