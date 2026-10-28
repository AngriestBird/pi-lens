---
section: Fixed
audience: internal
---

- The Bash guard hook now follows `cd -P` physically, resolves a not-yet-existing destination below a symlinked parent through its nearest existing ancestor, and no longer loses a command after a `case` pattern or `$'\''` inside `$( )` (refs #4060).
