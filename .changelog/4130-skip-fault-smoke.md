---
section: Fixed
audience: internal
---

- Tool-smoke now fails a runner whose tool was killed, timed out or rejected its invocation, instead of rendering it as a skipped tool. The skip carries the fault kind, and an absent tool still skips. (refs #4130)
