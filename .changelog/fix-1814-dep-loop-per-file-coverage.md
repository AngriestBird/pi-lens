---
section: Fixed
---

- **A warm session's dependency index no longer vacuously clears files it
  never scanned** — `isEntryFresh`'s per-file dependency check used to treat
  "this file is absent from the reverse-deps index" the same as "the index
  confirmed this file has zero imports": both returned an empty import list,
  so the freshness loop iterated zero times and reported clean. A session
  with a real index covering the rest of the project could still fail-open,
  with no signal at all, for the one file outside that index's own coverage.
  `getImports` now returns `undefined` for an uncovered file instead of
  silently coercing it to `[]`, and a clean entry stamped with dependency
  knowledge is refused and evicted for that file the same way #1793 already
  refuses one on a session with no index at all. Refusals from both cases
  share the existing `depIndexColdRefusals` counter in `latency.log`.
