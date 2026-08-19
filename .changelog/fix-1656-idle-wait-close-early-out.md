---
section: Fixed
---

- **`safeSpawnAsync`'s post-exit pipe-idle wait no longer pays out its full 100ms grace window on every call (refs #1656)** — the wait now finishes as soon as Node's `close` event fires (the stronger, already-available signal that stdio is fully released), instead of always idling out the timer. A normal spawn, where nothing holds its pipes open, now settles in a few ms again; a daemonized descendant that never emits `close` is unaffected and still bounded by the existing grace/cap timers.
