---
section: Changed
audience: internal
---

- **Pin the tool-tree cache action to actions/cache v6.1.0 (#4417)** — the composite action's restore and save steps moved from the v4.3.0 SHA to the v6.1.0 SHA that `ci.yml` already pins, so one action repository has one SHA across the workflow tree, as `tests/config/action-pin-split.test.ts` requires.
