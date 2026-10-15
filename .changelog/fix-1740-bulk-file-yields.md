---
section: Fixed
audience: user
---

- **Keep the host responsive between files during project scans and full graph builds.** Diagnostic scans now let pending requests and cancellation callbacks run after each completed file, and full graph extraction does the same after checkpoint bookkeeping. Individual file analysis and final graph resolution can still block. (Refs #1740)
