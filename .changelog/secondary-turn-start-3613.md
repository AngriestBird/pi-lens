---
section: Fixed
audience: user
---

- A subagent running in the same pi process no longer starts a new turn for the main session: its `turn_start` used to advance the main session's turn and clear the code-quality and actionable warnings the main session's edits had recorded, so the main session's turn end reported none of them. Each session's turn warnings are now its own, so neither session's turn end reports or clears the other's.
