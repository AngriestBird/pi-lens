---
section: Changed
audience: internal
---

- Move 30 test files (31 `in-process-mock` rows) off `vi.mock` of `clients/user-notify`, `degradation-ledger`, `warm-attach`, `widget-state` and `file-utils` and onto the real modules with their reset or env knob, deleting the rows (#4709).
