---
section: Fixed
---

- **Cascade tier-3 registry now resets at session_start (closes #1910)** — the outstanding-touch registry and its sweep-scoped expired/evicted counters (`clients/lsp/cascade-tier.ts`) used to survive a session replacement, so a new session inherited the prior session's outstanding touches and a stray eviction or expiry landed on the next session's first reconcile gauge. `handleSessionStart` now clears both, primary-only, same as every other per-session latch in that reset block.
