---
section: Fixed
audience: user
---

- **Turn-end findings reach only the session that produced them:** with two sessions in one pi process (an in-process subagent), the blockers and advisories a session's turn end staged for its next request are no longer taken by the other session's request first, so a subagent no longer loses its own blocker to the parent session, and the parent no longer reads the subagent's. A subagent's own test-runner results now reach the subagent instead of no one. A new session that replaces the one that staged a message (`/new`, a fork, or a fresh process) no longer receives that unconsumed message (refs #4943).
