---
section: Added
audience: internal
---

- Add a `test-env-restore` ratchet sweep: an env write in test source with no restore in the same file reds, the write enumerator fails closed on an unrecognised spelling, and every admitted row carries a reason that the sweep re-checks (#4589).
