---
section: Fixed
---

- **Pre-push now fails instead of silently skipping targeted tests when the machine-wide test lock times out (closes #3717)** — `PI_LENS_PREPUSH_LOCK_SKIP=1` is the only explicit opt-out and emits a loud warning.
