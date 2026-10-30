---
section: Fixed
audience: internal
---

- `tests/index-lsp-config-root-eviction.test.ts` now emits `session_shutdown` and joins the background-write drain registry and the instance-registry mutation tail before it removes its `PI_LENS_HOME` fixture, so a late project-snapshot worker write can no longer re-create the directory after teardown and red the tmp-fixture hygiene owner (refs #5024).
