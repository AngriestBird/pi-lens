---
section: Fixed
---

- **Bound the playground rule verifier's child-process wait (closes #1679)** — `scripts/playground-verify-rule.mjs` spawned its CDP/Chrome helper scripts and waited on the child's `close` event with no timeout. A wedged or daemonized child hung the script forever. It now routes through the shared `safeSpawnAsync` (bounded timeout, tree-kill), matching the rest of the codebase's spawn discipline.
