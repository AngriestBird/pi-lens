---
section: Fixed
---

- **Review-graph supersession cleanup is deterministic (refs #1318)** -- a superseded generation's staged write is reaped synchronously (and fault-tolerantly) before completion becomes observable, so CI waiters can no longer observe a leftover stage file; the supersession lock test moved to the quiet timing-sensitive phase.
