---
section: Changed
audience: user
---

- **The source walk answers compiled-twin lookups from the directory listing it already read (#1979)**. A `.js`, `.mjs`, `.cjs` or `.jsx` file no longer costs up to seven filesystem existence checks for a `.ts` or `.vue` twin; a twin-less file costs none, and a file that has one is still checked once against the real filesystem. Which files the walk keeps does not change. The review-graph size-skip record now also reports `entriesVisited` and `walkMs`, so a slow over-cap first build can be told apart as a slow collection or a large tree. `walkMs` covers the whole source collection, including the tracked-file index prime. The verdicts match the old walk on a tree that does not change during the walk. Refs #1979 (the cold-IO cost of the first walk is reduced, not removed).
