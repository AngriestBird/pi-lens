---
section: Fixed
---

- **Harden the CI classifier's automatic PR comment path (closes #2318, refs #2316)** — escape log-derived HTML comment delimiters, neutralize mentions, and accept only the final anchored classifier marker so failed test output cannot forge rerun suppression or ping users.
