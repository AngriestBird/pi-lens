---
section: Fixed
---

- **`mutation (advisory)` no longer false-reds on `scripts/with-memory-watch.mjs` (closes #3108)** — its two source-text pins in `tests/scripts/with-memory-watch.test.ts` matched only the un-instrumented wrapper, so Stryker's in-place `// @ts-nocheck` + switch-mutant scaffolding (added even with no mutant active) failed the dry run on every PR that edited the file. The pins now tolerate that optional wrapper and still red when the pinned code is genuinely removed.
