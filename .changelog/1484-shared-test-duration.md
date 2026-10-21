---
section: Fixed
audience: user
---

- **Normalize every test-run duration through the shared measurement contract.** Pytest, ExUnit, PHPUnit, JSON results, and sub-millisecond vstest readings now use the same normalizer; malformed ExUnit readings remain unmeasured instead of carrying `NaN` (#1484).
