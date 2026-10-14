---
section: Fixed
audience: user
---

- **pi no longer exits when a snapshot worker fails before staging a file (refs #4400)** — the project-snapshot and review-graph persist workers hand their result back with the path of the file they staged. A worker that failed before staging it, or a build that did not echo it, left that path out, and the host removed it unchecked. The resulting `ERR_INVALID_ARG_TYPE` ended pi on the first save of a session, as in an RPC chat. The host now cleans up and promotes the stage path it sent itself, so a failed worker falls back to the main-thread write like any other worker error. Reported by timges.
