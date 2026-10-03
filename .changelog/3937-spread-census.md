---
section: Changed
audience: internal
---

- Harden the mutation-bridge epoch/lineage census against spread-forwarded
  entries: fold bounded per-output object/spread provenance, prove the `lineage`
  VALUE defined (not merely named) wherever an epoch is present, fold `a && b`
  by the left's truthiness so a guarded lineage spread cannot launder an
  unconditional epoch beside it, enumerate the callees rebound through
  destructuring, property aliases, subscripts, defaults, and sequences, treat
  destructuring assignment and `delete` / `Object.assign` / `Object.defineProperty`
  / `Reflect` targets as mutations, skip in-object comments, register every
  unresolved forwarding with a checked reason, and fail on an epoch that cannot
  carry lineage (#3937).
