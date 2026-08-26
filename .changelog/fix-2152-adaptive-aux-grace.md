---
section: Fixed
---

- **Adapt the first cold auxiliary wait to observed spawn cost (closes #2152)** — a cold auxiliary touch derives its grace ceiling from the server's last successful spawn duration, adds a bounded 500ms margin, and caps the result at 8s. Warm touches retain the 2s fast path, and `PI_LENS_AUX_GRACE_MS` remains an explicit override.
