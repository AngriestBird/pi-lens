---
section: Changed
audience: internal
---

- The session-state owner-key check now covers the file-level exemptions, the declared session stores, reset-less module containers and class fields bound to a container, so state the #4965 bugs sat in is no longer outside it. (refs #5027)
