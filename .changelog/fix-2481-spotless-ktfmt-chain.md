---
section: Fixed
---

- **Carry Spotless ktfmt styles into the standalone formatter (closes #2481)** — `googleStyle()` and `kotlinlangStyle()` now map to ktfmt CLI flags. `dropboxStyle()` records the CLI limitation and falls back to the bare invocation.
