---
section: Fixed
---

- **Close two named remainders from the #2088 sweep-floor fix (refs #2088)** — the sweep-floor meta-sweep now recognizes the `expect(x.length).toBe(0)` emptiness spelling (14 test files use it, previously invisible to the census), and `managed-tool-seam-coverage` gained a positive control on its `safeSpawnAsync(` detector so a regex that stops matching fails loud instead of reading as zero violations.
