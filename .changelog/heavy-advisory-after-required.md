---
section: Changed
---

- Start the heavy advisory CI jobs (`mutation (advisory)` and `Unit tests Windows (advisory)`) only after every required check passed on the same head, through a `Heavy advisory gate (advisory)` job in `ci.yml` (the mutation lane moved from `mutation.yml` into `ci.yml` so `needs:` can hold it), and pack the Unit tests shards by recorded per-file duration instead of vitest's equal-count path hash. ci-verdict lists the deferred jobs as PENDING until they start and never gates on them; required check names are unchanged (refs #3801, #3771).
