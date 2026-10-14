---
section: Changed
audience: internal
---

- A PR's added or changed test files run alone and under two fixed shuffle seeds in `Targeted tests (advisory)` (#4397). `scripts/ci-shuffle-changed-tests.mjs` reds a file whose cases share state, within a 6-minute budget and a 20-file cap. Four order-dependent cases on master are fixed: three in `lens-diagnostics.test.ts` and one in `lsp-diagnostics-no-client-4322.test.ts`.
