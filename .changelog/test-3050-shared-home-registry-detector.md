---
section: Added
---

- **Detect tests that drive the registry against the run-shared `PI_LENS_HOME` (refs #3042, #3050)** — `tests/clients/pi-lens-home-hermeticity.test.ts` now walks `clients/` for best-effort-locked `getGlobalPiLensDir()` writers and `tests/` for files that call one of their hazardous exports (or reach a producer's target file directly) without pinning their own home or mocking the writer away; it caught `tests/clients/instance-reaper-backstop.test.ts` racing the shared `orphan-backstop.json`/`.lock` on a stale per-worker-isolation assumption, fixed in the same change.
