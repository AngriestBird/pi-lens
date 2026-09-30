---
section: Fixed
---

- Test teardown drains fire-and-forget registry mutations before worker termination, and scoped root deregistration waits through the lock lease. Closes #3617. Closes #3618.
