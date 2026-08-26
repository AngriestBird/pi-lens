---
section: Fixed
---

- **Fail loudly when the stale open-issues scan is truncated (closes #2104)** — the weekly detector proves exhaustion for the open-issue population, fails loudly when its safety bound is reached, and reports the scanned population. The master commit read remains a deliberately bounded recent window and reports commits beyond its detail cap.
