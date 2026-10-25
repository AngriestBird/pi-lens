---
section: Changed
audience: internal
---

- Key every inline-blocker and deferred-format accessor of the runtime coordinator by the raw spelling through `normalizeMapKey`, and absolutize a deferred mutation with `realpathOrResolve`. A spelling that goes through a directory link with `..` (`link/../file.ts`) now reaches the same record through every accessor; common spellings are unchanged (#4689).
