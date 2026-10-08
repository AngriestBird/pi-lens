---
section: Fixed
audience: user
---

- **Repeated grammar failures no longer exhaust the shared parser heap.** A grammar that traps on distinct inputs is retired until restart, so the runner reports it unavailable instead of clean and other languages retain the remaining budget (refs #4010, #3996).
