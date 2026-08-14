---
section: Fixed
---

- Bound and evict rebuildable Tier 2 reverse-dependency, tree-sitter query, and workspace-topology caches while retaining unconsumed ReadGuard records until their edit or session end (refs #1389; widget-state and Tier 3 remain deferred).
