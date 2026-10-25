---
section: Changed
audience: internal
---

- Drop six no-op `path.resolve` wrappers on the coordinator's `PathKeyedMap` keys (inline blockers and deferred format). Every caller already passes a resolved path, so behaviour is unchanged; the path-identity and glossary pins move down with the sites (#4689).
