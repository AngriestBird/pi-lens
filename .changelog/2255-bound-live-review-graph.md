---
section: Fixed
---

- **Bound the in-memory review graph, not just its on-disk snapshot (refs #2255, #2240)** — the live `ReviewGraph` retained per workspace grew with project size and had no size guard; only the persisted snapshot was capped. On a large repository it was the second unbounded dispatch store behind the multi-gigabyte OOM abort (`FactStore` was the first, bounded in #2243). The retained graph is now capped by estimated resident bytes (`PI_LENS_GRAPH_MAX_IN_MEMORY_BYTES`, default 512 MiB), evicting with the same centrality-ranked induced-subgraph selection the snapshot already uses. A trimmed graph is marked partial, which the build path already treats as read-only orientation and refuses as an incremental base, so the next build re-derives the full graph rather than extending a truncated one. Each trim emits one bounded degradation record per workspace naming the before/after node, edge, and byte counts.
