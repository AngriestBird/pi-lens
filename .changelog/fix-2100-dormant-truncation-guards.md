---
section: Fixed
---

- **Truncated tool output is reported as truncated.** Several spawn sites (`git status` opaque recovery, oxlint, `helm lint`, `helm template`, and the shared-checkout working-tree probe) retained unbounded stdout and carried truncation guards that could never fire. Each now caps its output, and every truncation guard in the tree reads `truncatedByOutputCap` before failure or status handling. `safeSpawnAsync` now records `killedForOutputCap`, so callers handle cap termination without guessing from POSIX or Windows exit shapes. A run that hit the cap and then timed out or was interrupted still reports the timeout or abort. Also corrected the trivy scan, `sg` exec/scan, and ast-grep pattern validation. The shared runner ledger now says a tool was stopped at its output cap instead of blaming it for a kill pi-lens sent.
