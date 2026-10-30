---
section: Fixed
audience: internal
---

- Joins the loaded extension copy's deferred snapshot and probe-cache writes (and its NDJSON rows) before the tier-2 test helper removes its fixture root, so a late write no longer re-creates the root and reds the tmp-fixture hygiene census (refs #4937).
