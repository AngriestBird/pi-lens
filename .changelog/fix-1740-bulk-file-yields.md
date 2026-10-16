---
section: Fixed
audience: user
---

- **Keep the host responsive between files during project scans.** Diagnostic scans now let pending requests and cancellation callbacks run after each completed file. Individual file analysis can still block, and full graph builds still run without a break. (Refs #1740)
