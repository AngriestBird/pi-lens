---
section: Fixed
audience: internal
---

- Real-harness teardown waits for the pi child to exit before removing its
  scratch home and routes owned-project cleanup through the shared bounded
  retry helper, so a late child write cannot turn a passing scenario into an
  `ENOTEMPTY` teardown failure (refs #4081).
