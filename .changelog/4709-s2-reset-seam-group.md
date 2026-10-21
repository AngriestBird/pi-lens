---
section: Changed
audience: internal
---

- Move 31 test files off `vi.mock` of `clients/user-notify`, `degradation-ledger`, `warm-attach`, `widget-state` and `file-utils` and onto the real modules with their reset or env knob, deleting their `in-process-mock` baseline rows (#4709).
