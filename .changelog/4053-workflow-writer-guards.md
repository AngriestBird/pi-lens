---
section: Fixed
audience: internal
---

- Guard every dispatchable workflow that writes shared GitHub state (tracking issues, releases, npm, labels, stale sweeps) so a branch dispatch cannot run it, enforced by a parsed-workflow census, and reject shell variables in action inputs.
