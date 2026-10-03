---
section: Changed
audience: internal
---

- Harden the mutation-bridge epoch/lineage census against spread-forwarded entries: fold bounded per-output object/spread provenance, enumerate the callees rebound through destructuring, property aliases, and subscripts, treat `delete` and `Object.assign` targets as mutations, register every unresolved forwarding with a checked reason, and fail on an epoch that cannot carry lineage (#3937).
