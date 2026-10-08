---
section: Fixed
audience: user
---

- gitleaks, trivy and opengrep now leave every linked git worktree nested under the project root out of their scan, whatever the worktree directory is called, instead of only the ones under a known directory name (fixes #4132).
