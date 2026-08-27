---
section: Fixed
---

- **Make the spawn-timeout cooldown regression test load-invariant (closes #2235)** — load the real pipeline during test-module setup so the 5000ms test budget measures cooldown behavior instead of contention during a heavy dynamic import.
