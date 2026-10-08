---
section: Fixed
audience: user
---

- **A grammar that traps on two distinct files is retired, not retried until the heap aborts.** The runner reports the language unavailable instead of clean and other languages keep the remaining trap budget; a file that traps once and then parses cleanly does not count (refs #4010, #3996).
