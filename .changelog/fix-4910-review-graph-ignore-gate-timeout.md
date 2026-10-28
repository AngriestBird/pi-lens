---
section: Fixed
audience: internal
---

- The review-graph ignore-gated node test follows the lane's test-timeout scale instead of the 5 s default, so a slow Windows runner no longer times it out (closes #4910).
