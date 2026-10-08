---
section: Fixed
audience: user
---

- **Pytest and go.mod parsing no longer stall on blank-heavy input (#4148)** — Reading a pytest failure traceback and the `module` line of a `go.mod` now takes linear time, so a run with tens of thousands of blank lines or one very long `_` rule no longer blocks the host for seconds (13 s and 4 s at 100K lines before).
