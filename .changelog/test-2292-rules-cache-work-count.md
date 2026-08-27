---
section: Fixed
---

- **Guard the warmed YAML rules cache with load-invariant work counts (closes #2292)** — assert that repeated cache hits perform no directory, metadata, or content reads inside the freshness cadence, and that the next cadence performs one metadata sweep without reading rule content.
