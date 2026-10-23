---
section: Fixed
audience: user
---

- **A second session no longer erases another session's CVE or secret blocker.** Under `--lens-guard`, a project-wide blocker that names no file (a CRITICAL dependency CVE, a leaked secret, an unlisted dependency) stays with the session that reported it. That session's next turn end replaces it. Any session's turn end drops it once 30 minutes pass without that session rewriting it. Before, the next turn end of any other session dropped it unchecked, and `git commit` then ran (#4750).
