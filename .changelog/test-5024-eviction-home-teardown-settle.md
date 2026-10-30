---
section: Fixed
audience: internal
---

- `tests/index-lsp-config-root-eviction.test.ts` now joins the background-write drain registry before it removes its `PI_LENS_HOME` fixture, so a late project-snapshot worker write no longer re-creates the directory after a settled teardown and reds the tmp-fixture hygiene owner. The instance-registry mutation tail is left to the environment restore and the worker's own teardown (refs #5024).
