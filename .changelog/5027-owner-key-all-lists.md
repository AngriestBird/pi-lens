---
section: Changed
audience: internal
---

- The session-state owner-key check now covers the file-level exemptions, the declared session stores, reset-less module containers, class fields bound to a container and containers held as members of a module-level object, so state the #4965 bugs sat in is no longer outside it. (refs #5027)
