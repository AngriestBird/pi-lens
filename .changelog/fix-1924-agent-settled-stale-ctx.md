---
section: Fixed
---

- **agent_settled no longer crashes with extension_error when the session is
  replaced mid-run** — stale extension ctx reads are guarded and the ambient
  abort signal is cleared (closes #1924; thanks @Pluto-Yt).
