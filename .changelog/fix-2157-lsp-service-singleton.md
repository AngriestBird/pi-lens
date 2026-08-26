---
section: Fixed
---

- **Share one LSP service across module evaluations (refs #2157)** — all evaluations now share one service and reset its live clients through the process-wide singleton container.
