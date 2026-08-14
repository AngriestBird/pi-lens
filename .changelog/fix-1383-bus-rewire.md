---
section: Fixed
---

- **Widget and inter-extension bus updates recover after session replacement (closes #1383)** — every `session_start`, including the #473 guarded in-process subagent path, now reclaims activation-scoped bus, notifier, and widget-render wiring before returning. Stale bus failures are logged and ledgered once per failure occurrence, with a successful publish re-arming observability for a later channel death.
