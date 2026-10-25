---
section: Fixed
audience: internal
---

- **install-smoke mise-repro runs the real pi, not the mise shim.** The RPC smoke pins HOME to a scratch dir, so a `pi` shim could not resolve its tool and the advisory leg failed on every master run after #4821 (#4789, #4821).
