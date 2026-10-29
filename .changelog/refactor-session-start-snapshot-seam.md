---
section: Changed
audience: internal
---

- Quick and full session start share one sequence-read and snapshot-hydrate step instead of two 60-line copies and the shared step's sequence read is capped at the session_start wall budget even under a widened `PI_LENS_SEQUENCE_READ_BUDGET_MS` (refs #4907).
