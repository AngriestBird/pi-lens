---
section: Fixed
audience: internal
---

- **The #3521 fork-tree witness no longer arms the machine-wide orphan reaper (#3917)** — the file starts 25 real sessions whose `session_start` schedules the registry-independent backstop sweep. That sweep enumerates the host process table, so a live foreign orphan whose owner is dead was eligible and the #2042 kill guard failed the file at teardown even though every test passed. The file now turns the instance registry off for its own sessions, exactly as its sibling session files do, and a witness pins that the real sweep consults the kill switch before it reaches the process-table seam.
