---
section: Fixed
audience: internal
---

- Pin a fixture `HOME` outside every root the harness deletes (`pinFixtureHome`), so a child a test never awaits can no longer re-create a `pi-lens-*` temp root after its file's teardown sweep, and record a leaked entry's birth time and first-level children so the next such leak is attributable (refs #4591).
