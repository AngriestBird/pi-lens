---
section: Fixed
---

- **Avoid false read-guard blocks after formatter writes ([closes #1903](https://github.com/apmantza/pi-lens/issues/1903))** —
  Bash-invoked in-place formatters and fixers now refresh explicit file write
  stamps. A uniquely resolved edit `oldText` also overrides coarse FileTime
  staleness, while missing or ambiguous content evidence remains blocked.
