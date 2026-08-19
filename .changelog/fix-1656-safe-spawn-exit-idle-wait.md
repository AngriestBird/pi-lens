---
section: Fixed
---

- **`safeSpawnAsync` no longer hangs forever on a daemonized descendant that inherits its stdout/stderr pipe (refs #1656)** — the async spawn path waited for Node's `close` event, which only fires once every file descriptor referencing the child's stdio has been released. A Windows-orphaned grandchild (no job object) can hold that inherited pipe open indefinitely, so `close` never fires even though the process we spawned is long dead — the caller hangs, and a hung prober silently loses its result rather than failing loudly. Adopting pi's `waitForChildProcess` construction: finalize off `exit` instead, then wait for stdout/stderr to fall idle (no data for 100ms, re-armed on every chunk, capped at 2s so a pathological never-quiet descendant can't extend the caller's overall budget). A quiet inherited handle now releases after one grace window; an actively-streaming child is still captured in full.
