---
section: Fixed
audience: user
---

- **A subagent's read no longer licenses the parent's edit, nor the reverse:** with two sessions in one pi process (an in-process subagent), the read guard now keeps each session's read records and write authorship apart, so an edit is refused unless the editing session itself read the file. A session's own read still licenses its own edit (refs #4942).
