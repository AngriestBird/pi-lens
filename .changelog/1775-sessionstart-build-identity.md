---
section: Added
---

- **Record build identity at session start (refs #1775)** — `sessionstart.log` now logs one bounded line per session start with the serving checkout's commit hash, entry-file mtime, and package version, derived from the running build's own files rather than `process.cwd()`. The dirty flag is deferred (would require a spawn on the session-start hot path); see the issue for the remainder.
