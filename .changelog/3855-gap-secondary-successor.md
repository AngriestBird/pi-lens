---
section: Fixed
audience: user
---

- A subagent that reloads, forks or resumes itself while the main session is reloading no longer takes over as the main session, so the reloaded session keeps its reads, its queued notices and its activated tools (#3855).
