---
section: Changed
audience: internal
---

- Four review-found shapes now red instead of waiting for a reviewer (#4427). `tests/config/lsp-index-config-import-pin.test.ts` pins the exact symbols `clients/lsp/index.ts` takes from `./config.js`. A rise in the `vi.mock` sweep's missing-export count fails `tests/config/vi-mock-export-sweep.test.ts` (the baseline admits the 70 rises the old warning hid). `tests/config/live-pin-literal-sweep.test.ts` reds on a literal in `tests/config` that spells a live workflow action pin, and the heavy-gate and writer-governance tests derive their pins with `siblingPin`. `tests/config/github-bearer-ratchet.test.ts` reds on a `Bearer` header in `scripts/` outside `scripts/lib/github-rest.mjs` and two named exceptions, and the action-pin, stale-issue and CI-failure scripts build their headers with `githubHeaders` and `githubFetcher`. `lint:js:promises` also denies `typescript/await-thenable` (#4428).
