---
section: Fixed
audience: internal
---

- The stale-ctx session-start scan test drains its background snapshot writes before it removes its fixture root, so a late write no longer recreates the root for the tmp-fixture hygiene census (#4958).
