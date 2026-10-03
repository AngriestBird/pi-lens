---
section: Changed
audience: internal
---

- Harden the mutation-bridge epoch/lineage census against spread-forwarded entries: fold bounded local object/spread provenance, register every unresolved forwarding with a checked reason, and fail on an epoch that cannot carry lineage (#3937).
