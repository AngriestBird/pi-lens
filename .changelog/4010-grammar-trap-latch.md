---
section: Fixed
audience: user
---

- **Repeated grammar failures no longer exhaust the shared parser heap.** A grammar that repeatedly traps is retired for the session, so other languages remain available (refs #4010, #3996).
