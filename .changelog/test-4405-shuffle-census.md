---
section: Added
audience: internal
---

- Repo-wide shuffle census for order-dependent test files (#4405). `scripts/ci-shuffle-census.mjs` runs every test file alone and under seeds 202, 424 and 606 through the changed-files job's planner and runner, re-runs each shuffled member alone under its seed, and diffs the members against `scripts/shuffle-census-ratchet.json`: a new member reds, a fixed one must leave the list. The first pass found 33 order-dependent files of 1449; the leaked `vi.doMock` registrations in `index-integration` and `tree-sitter-runner` are fixed, the other 31 are listed by seam.
