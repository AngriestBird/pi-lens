---
section: Fixed
audience: user
---

- **A subagent's edits are logged under its own session:** with two sessions in one pi process (an in-process subagent), the change log, the diagnostics log and the read-guard log now name the session that made the write, and a runner answer that finished after the subagent's edit (a collect-later run) is drained by that subagent's turn end, with its blocker recorded as the subagent's own instead of the parent session's (refs #4943).
