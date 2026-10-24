---
section: Fixed
audience: user
---

- **detekt exit 1 no longer reads as a clean file.** detekt exits 1 when its configuration is invalid, and it prints the error on stderr with no findings. That run now records a skipped runner result instead of a clean one (#4522).
