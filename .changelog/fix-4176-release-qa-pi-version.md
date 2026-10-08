---
section: Fixed
audience: internal
---

- **release-qa reads the pi version from `pi --version` only (closes #4176)** — The codemode row no longer takes an x.y.z from the pi binary's install path, so a version-shaped directory cannot make it run or skip on the wrong pi.
