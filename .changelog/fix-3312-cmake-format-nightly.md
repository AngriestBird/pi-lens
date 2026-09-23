---
section: Fixed
---

- Fixed the nightly formatter smoke environment so private pip-installed tools
  can import their packages, and retain a bounded formatter traceback tail for
  actionable failures (refs #3312).
