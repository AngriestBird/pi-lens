---
section: Fixed
---

- **Bus publishers avoid stale session contexts (refs #1415)** — Event producers re-resolve the current activation at delivery time and intentionally skip a confirmed-stale session target instead of logging a failed emit.
