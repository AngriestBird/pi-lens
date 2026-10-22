---
section: Fixed
audience: user
---

- **An offline opengrep no longer reads as a clean scan.** A server that reports over `window/showMessage` that its config or rules failed to load now records one bounded degradation, and its empty publications stop counting as evidence, so the touch reports the scanner as unconfirmed instead of clean, and the coverage-gap record carries the server's own failure text (#4764).
