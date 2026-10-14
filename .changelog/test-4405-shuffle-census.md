---
section: Added
audience: internal
---

- Repo-wide shuffle census for order-dependent test files (#4405). `scripts/ci-shuffle-census.mjs` runs every test file under seeds 202, 424 and 606 (and alone, weekly) through the changed-files job's planner and runner, re-runs each failing member alone under its seed, reruns a chunk whose member passed alone, and diffs the member files against `scripts/shuffle-census-ratchet.json`, keyed by file: a new member reds, and an entry clean two nights running must leave the list. `shuffle-census-nightly.yml` runs it as six parallel parts and keeps one tracking issue. The first pass found 33 order-dependent files of 1449; the leaked `vi.doMock` registrations in `index-integration` and `tree-sitter-runner` are fixed, the other 31 are listed by seam.
