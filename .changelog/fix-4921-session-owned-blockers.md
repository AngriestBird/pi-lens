---
section: Fixed
audience: user
---

- **A subagent no longer receives the parent session's blockers:** with two sessions in one pi process (an in-process subagent), each turn end now delivers, sweeps and re-judges only the inline blockers its own session's writes recorded, and the commit-gate record files each session's blocker section under that session's id. A subagent's turn end no longer saves the parent's session state into the subagent's project data dir or stamps that project's duplicate-findings record with the parent's id (refs #4921).
