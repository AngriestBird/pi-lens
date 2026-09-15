---
section: Fixed
---

- **Carry Spotless ktfmt styles into the standalone formatter (refs #2481)** — `googleStyle()` and `kotlinlangStyle()` now map to ktfmt CLI flags when Spotless configures the Kotlin formatter. Spotless `dropboxStyle()` falls back to bare ktfmt with a bounded notice because the pi-lens standalone CLI cannot express that style.
