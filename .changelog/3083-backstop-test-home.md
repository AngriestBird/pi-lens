---
section: Fixed
---

- **Isolate test orphan-backstop state (refs #3083)** — pin the backstop lock and cooldown stamp once in the test harness so real session-start timers cannot contaminate the run-shared home, while preserving explicit test homes and production machine-wide coordination.
