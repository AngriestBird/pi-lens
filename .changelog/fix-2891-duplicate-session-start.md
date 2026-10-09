---
section: Fixed
audience: user
---

- **Duplicate pi session starts are ignored safely.** pi-lens now drops repeated `session_start` events at entry while preserving distinct reload, new, resume, and fork starts (refs #2891).
