---
section: Fixed
audience: user
---

- **A dead-code scan that finishes late no longer crashes pi-lens or stalls on a disk error (closes #4661).** When a Python dead-code scan outlived the turn_end budget and the disk then refused its baseline write (full, read-only, or the cache path taken by a file), the error escaped as an unhandled rejection and the scan stayed parked, so every later turn reported it as in flight and never started another. The scan is now dropped and counted as `dead-code-late-scan-dropped` with the error, and the next turn scans again.
