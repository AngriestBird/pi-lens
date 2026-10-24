---
section: Fixed
audience: user
---

- **A reload during session start no longer raises an unhandled rejection from the startup scans** — the background scans wait for the analyzer clients to load before reading the host's flags. A reload that landed in that wait made the read throw the host's stale-context error from a task nothing caught, which can end a Node host's process. The replaced session now skips its scans and records one `extension-ctx-stale` entry (subject `session-start-scans`); the session that replaced it runs its own scans. (#4815)
