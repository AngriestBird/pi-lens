---
section: Fixed
---

- **`safeSpawnAsync`'s post-exit pipe-idle wait no longer lets a late, unrelated error steal an already-decided healthy verdict (refs #1656)** — the wait added to fix the daemonized-descendant hang left the outcome undecided across the whole (bounded, up to 2s) idle-grace window, widening a race a prior fix had closed down to a single microtask: a post-exit `kill()` failing with EPERM 10ms after a clean `close(0, null)` could flip a successful run to a spawn failure. The verdict is now latched immediately once the exit/close event decides it, before the idle wait runs, so a late `error` can never downgrade it.
