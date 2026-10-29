---
section: Changed
audience: internal
---

- Every session-state registry entry now names its owner key (`session`, `repository`, `project` or `process-wide: <reason>`), a new `SessionKeyedStore` seam replaces the three hand-rolled session partitions (the coordinator's turn warnings and the two cache-observability tables), and the conformance test refuses a `session` owner that is neither on the seam nor states why (defect shape 72, refs #4965).
