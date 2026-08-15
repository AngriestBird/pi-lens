---
section: Fixed
---

- **Settle native TS7 cascade checks (closes #1444)** — Cascade neighbor checks on native TS7 no longer burn the in-lane wait budget on a publication that only arrives later; the result is collected in the quiet window instead, and a late clean result now also clears the neighbor's stale footer errors. On the classic (full-wait) lane, a neighbor whose diagnostics wait lapsed used to produce no output at all — which read as "clean" — and now renders an explicit inconclusive note; unconfirmed checks are still never cached as clean. `cascade_result` records how many neighbors were deferred, so a fully-deferred cascade is distinguishable from a clean leaf.
