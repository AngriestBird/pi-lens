---
section: Fixed
---

- **Keep crash-only rethrow options out of session event wrappers (refs #2969)** — Separate handler crash options from stale-session event guard options so wrapper registrations cannot suggest an unsupported crash policy.
