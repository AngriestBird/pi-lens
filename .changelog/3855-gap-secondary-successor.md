---
section: Fixed
audience: user
---

- A subagent that reloads, forks, resumes or starts a new session while the main session is between its reload, fork, resume or new-session shutdown and its next start no longer takes over as the main session. The main session's own successor stays the main session and keeps its reads, its queued notices and its activated tools (#3855).
