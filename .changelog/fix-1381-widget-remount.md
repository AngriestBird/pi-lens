---
section: Fixed
---

- **Re-assert widget mounts after host UI replacement (closes #1381)** — The diagnostics widget remounts on the live UI at turn start when needed, while preserving mode and user visibility gates; unsupported widget hosts now emit a log-once diagnostic.
