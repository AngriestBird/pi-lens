---
section: Fixed
audience: user
---

- **Restore ast-grep warning history.** The debounced warning scan now selects the registered runner instead of silently selecting none. This enables the existing background scan after JavaScript/TypeScript writes; findings remain history-only. (closes #4312)
