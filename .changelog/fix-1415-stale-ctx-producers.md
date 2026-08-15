---
section: Fixed
---

- **Bus publishers keep activation context ownership (closes #1415)** — Event producers pair each live emitter with its OWN activation's context (no fallback to a process-global "latest ctx", which could belong to an unrelated sibling activation) and guard lens events through the shared stale-session seam with the same occurrence-scoped failure gating every other producer uses. Lens emit failures now count toward the `bus-stale` degradation smell like every other producer's — intentional: a probe-undefined or resolve/emit race on the lens path is a genuine failure that should be visible, not silently excluded.
