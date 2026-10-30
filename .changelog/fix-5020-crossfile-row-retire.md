---
section: Fixed
audience: user
---

- **A blocker row naming another file retires with that file (refs #5020)** — a helm-lint, helm-render or mypy row recorded against the written file now leaves once the file it names is written clean or deleted, so the commit gate no longer stays shut on a finding nothing can fix.
