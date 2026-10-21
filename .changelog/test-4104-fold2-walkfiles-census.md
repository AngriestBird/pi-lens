---
section: Fixed
audience: internal
---

- **The census sees the repo-wide walker (#4104)** — `walkFiles` joins the walk helpers of the tree-scanner census (`tests/config/targeted-tests-workflow.test.ts`, including its import alias) and the sweep-shaped enumeration of `tests/config/sweep-floor-coverage.test.ts`. The Git-fixture governance suite, which walks `tests/` and `scripts/`, is registered in both governance lists it now belongs to. Test and registry only; no product behaviour changes.
