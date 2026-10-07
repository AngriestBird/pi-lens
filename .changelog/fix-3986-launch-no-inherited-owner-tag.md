---
section: Fixed
audience: user
---

- **A language server launched by a host that cannot read its own start time no longer carries a dead foreign owner's tag (refs #3986)** — `launchLSP` now removes an inherited `PI_LENS_OWNER` when it has no tag of its own, so the orphan backstop spares that server instead of reaping it as owned by a dead process.
