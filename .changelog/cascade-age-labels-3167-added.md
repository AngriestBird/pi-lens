---
section: Added
---

- **Carried cascade advisories and demoted delta rows now render with explicit age labels (refs #3167)** — a cascade result carried across a turn boundary renders `(carried 1 turn)`, a coverage advisory computed from a carried indeterminate run is labeled the same way, and a demoted delta file group closes with its own scan age through `formatCacheAgeLabel` — so an agent can tell a just-observed finding from one re-served from cache. The two `partial` delivery-gate entries naming this gap resolve to full.
