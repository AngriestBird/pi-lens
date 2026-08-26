---
section: Fixed
---

- **Truncated tool output is reported as truncated.** Four spawn sites (`git status` opaque recovery, oxlint, `helm lint`, `helm template`) retained unbounded stdout and carried truncation guards that could never fire. Each now caps its output, and every truncation guard in the tree reads `truncatedByOutputCap` before the failure/status handling — a capped read kills the child with SIGTERM, so the guards were sitting behind the kill they were meant to explain. A run that hit the cap and then timed out or was interrupted still reports the timeout or the abort. Also corrected for the trivy scan, `sg` exec/scan, and ast-grep pattern validation, and the shared runner ledger now says a tool was stopped at its output cap instead of blaming it for the signal we sent.
