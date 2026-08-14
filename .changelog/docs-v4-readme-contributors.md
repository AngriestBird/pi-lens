---
section: Changed
---

- **Refresh README/docs for v4 and update contributors** — reconciled the
  README feature list and `docs/` reference against current code: documented
  the four memory idle-eviction env vars (`PI_LENS_TS_IDLE_EVICT_MS`,
  `PI_LENS_WORD_INDEX_IDLE_EVICT_MS`, `PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS`,
  `PI_LENS_REVIEW_GRAPH_IDLE_EVICT_MS`), the session degradation ledger
  surfaced through `pilens_health`/`/lens-health`, deferred-format bounded
  concurrency, and the `--lens-guard` commit/push blocker; linked
  `docs/mcp.md` from the README and added an MCP-server bullet. Added six
  external contributors (Nathan Cooke, Eli Stark, Marvin Aziz, Mark Faga,
  aeturnal, floatGray) to the README contributors table, sourced from
  `git shortlog` and merged-PR authorship.
