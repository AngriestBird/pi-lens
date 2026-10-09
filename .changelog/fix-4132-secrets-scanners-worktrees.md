---
section: Fixed
audience: user
---

- **Scanners now avoid linked worktree duplicates.** Gitleaks, trivy and opengrep discover linked checkouts nested under the project root instead of relying only on known directory names; paths that a scanner cannot represent safely are reported as bounded scan degradations (fixes #4132).
