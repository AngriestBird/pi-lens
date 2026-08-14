---
section: Fixed
---

- Bound and evict rebuildable Tier 2 reverse-dependency, tree-sitter query, and workspace-topology caches while retaining unconsumed ReadGuard records until their edit or session end. ReadGuard now applies a high sanity cap with oldest-to-re-read eviction for read-only sessions (refs #1389; widget-state and Tier 3 remain deferred).
