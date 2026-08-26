---
section: Added
---

- **Record build identity at session start (closes #1775)** — `sessionstart.log` now logs one bounded line per session start with the serving checkout's commit hash, dirty flag, entry-file mtime, and package version, derived from the running build's own files rather than `process.cwd()`.
