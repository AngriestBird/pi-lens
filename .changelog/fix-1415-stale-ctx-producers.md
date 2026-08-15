---
section: Fixed
---

- **Bus publishers keep activation context ownership (closes #1415)** — Event producers pair each live emitter with its activation context, guard lens events through the shared stale-session seam, and retain the process-latest context only as a boot-window fallback.
