---
section: Fixed
---

- **Bound per-file session-fact growth in dispatch's `FactStore` (refs #2282)** — `session.baseline.*` (delta-mode diagnostic baselines), `session.baseline.cascade.*`, and the review-graph's per-file entity-snapshot/changed-symbols facts minted one `sessionFacts` key per distinct file touched and never evicted, so a several-hundred-file batch retained one to four entries per path for the process lifetime. `FactStore` now routes these through a bounded, LRU-capped sibling map (`setBoundedSessionFact`/`getBoundedSessionFact`) reusing #2243's count-cap-and-report discipline instead of a third mechanism; fixed-vocabulary session facts (tool availability, `session.reviewGraph`) are unaffected. `memory_sample`'s `dispatchCaches` gains a `sessionFactEntries` count so this footprint is visible in `latency.log`.
