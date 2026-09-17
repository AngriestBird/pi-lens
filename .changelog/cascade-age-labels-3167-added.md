---
section: Added
---

- **Carried cascade advisories and demoted delta rows now render with explicit age labels (refs #3167)** — a cascade result carried across a turn boundary renders `(carried 1 turn · scanned Xm ago)` from the run's own observation stamp (#1444's `publishedAt`, threaded to `CascadeRun.observedAt`), a coverage advisory computed entirely from carried indeterminate runs is labeled the same way on its own line, and a demoted delta file group closes with one scan-age line under that file's own header through `formatCacheAgeLabel` — so an agent can tell a just-observed finding from one re-served from cache. An absent or partial stamp renders `scan age unknown`, never a fabricated number. The two `partial` delivery-gate entries naming this gap resolve to full, and each carrying turn emits one bounded `cascade_carry_rendered` record.
