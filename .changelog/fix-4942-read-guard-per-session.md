---
section: Fixed
audience: user
---

- **A subagent's read no longer licenses the parent's edit, nor the reverse:** with two sessions in one pi process (an in-process subagent), the read guard now keeps each session's read records and write authorship apart, so an edit is refused unless the editing session has its own authorization for the file: its own read, its own write authorship, or an exemption it armed. Another session's read or exemption no longer counts, nor does another session's write that names its own session. A session's own read still licenses its own edit (refs #4942).
