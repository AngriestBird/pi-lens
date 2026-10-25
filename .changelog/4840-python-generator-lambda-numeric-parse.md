---
section: Fixed
audience: user
---

- **Two Python ast-grep false positives.** `no-return-value-in-generator` no longer treats a function as a generator because a nested generator lambda (`lambda: (yield)`) yields, and `unchecked-numeric-parse-python` no longer flags `int()`/`float()` over `round()` or `len()`, which always return numbers (#4840).
