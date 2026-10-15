---
section: Added
audience: internal
---

- Repo-wide shuffle census for order-dependent test files (#4405). `scripts/ci-shuffle-census.mjs` runs every test file under seeds 202 and 424 (and alone, weekly) through the changed-files job's planner and runner, re-runs each failing member alone under its seed, reruns a chunk whose member passed alone, and diffs the member files against `scripts/shuffle-census-ratchet.json`, keyed by file: a new member reds, an entry clean two nights running must leave the list, and a planned start with no record is unproven, never clean. The census test also checks that the census plans exactly the files the `vitest.config.ts` projects collect, so a config change that hides a file from every seed reds its own PR. `shuffle-census-nightly.yml` runs it as six parallel parts and keeps one tracking issue. The first pass found 33 order-dependent files of 1449 (seeds 202, 424 and 606); the leaked `vi.doMock` registrations in `index-integration` and `tree-sitter-runner`, the heartbeat case in `tmp-fixture-hygiene` (found by the CI rehearsal) and the leaked degradation ledger in `bounded-pid-file-lock` are fixed; the other 30 are listed by seam.
