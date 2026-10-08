---
section: Fixed
audience: user
---

- **Lint fallback no longer hides missing type coverage.** Type-bearing files keep the existing incomplete-coverage notice when their primary analysis was skipped, unavailable, or failed; type-capable fallbacks such as mypy can still complete coverage.
