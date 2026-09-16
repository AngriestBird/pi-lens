---
section: Changed
---

- **Close two gaps in the DegradationKind coverage sweep (refs #3071, #3138, closes #3140)** — `clients/degradation-ledger.ts` now declares `process-singleton-reset` (live at `getDegradationSummary()`'s read-time fold since #2146, previously undeclared); `tests/config/degradation-kind-coverage.test.ts` now also walks that same read-time fold's own `summary.push({ kind: ... })` emitters in `degradation-ledger.ts`, and resolves a bare-identifier `kind:` value (`TRUST_REFUSAL_KIND` at `clients/config-core/process-spec.ts`) against a same-file `const` binding rather than silently returning `[]` — an identifier the scan still cannot resolve now fails loud as `"<file>:<line> kind: <identifier> is unresolvable"` unless the site is named in the new `AUDITED_IDENTIFIER_KIND_SITES` list.
