---
section: Fixed
audience: user
---

- **detekt exit 1 no longer reads as a clean file.** detekt exits 1 when its configuration is invalid, and that run prints no findings. It now records a skipped runner result instead of a clean one. Findings that detekt printed before it exits 1 are kept (#4522).
