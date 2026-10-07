---
section: Fixed
audience: user
---

- `guard-bash` now follows the full `node_modules` symlink chain and fails closed when its target cannot be resolved, preventing destructive npm and delete commands from reaching a shared install (#4080).
