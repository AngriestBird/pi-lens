---
section: Fixed
---

- **A stray compiled `.js` under `tests/` no longer silently shadows its `.ts` source (closes #2232)** — `tests/` is excluded from `npm run build` and hidden from `git status` by `.gitignore`'s blanket `*.js` rule, so a `.js` file left there by an earlier local `tsc` run never gets rebuilt away or flagged as dirty. Test import specifiers end in `.js`, so Node resolved that stale file over the `.ts` source with no signal anything was wrong — a PR #2226 verify-round probe of a FIXED file reproduced pre-fix behavior for exactly this reason. A new vitest `globalSetup` (`tests/support/check-tests-js-shadow.ts`) walks `tests/` once per run and throws, naming every shadowed `.ts` file, if any `.js` sibling exists.
