---
section: Fixed
audience: internal
---

- Smoke checks reject every failed runner except completed checks with `blocking_diagnostics`, so parser failures and unconfirmed output no longer count as passes (refs #4130).
