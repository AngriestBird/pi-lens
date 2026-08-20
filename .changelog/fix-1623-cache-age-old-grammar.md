---
section: Fixed
---

- **Fix "age unknown old" grammar in lens_diagnostics cache-age notes (refs #1623)** — the render call sites that report a lane served from cache in `lens_diagnostics mode=full` (test-runner findings, the cheap project scan under `refreshRunners=cached`) appended the literal word "old" after `formatCacheAge` unconditionally. When the underlying cache metadata had a missing or corrupt timestamp, `formatCacheAge` already degraded to "age unknown" instead of fabricating a NaN age (#1623 fix-round F4) — but the caller still glued "old" onto it, rendering the ungrammatical "test-runner (age unknown old)". A new `formatCacheAgeOld` helper (`clients/project-diagnostics/extractors.ts`) is the single place that decides whether "old" belongs on the string; both render sites now go through it instead of hand-rolling the suffix.
