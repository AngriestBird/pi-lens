---
section: Fixed
audience: user
---

- **`--lens-guard` now opens for a blocker you marked false-positive on a turn that wrote no file**: the commit gate re-judges its latch on a turn whose only action is `lens_diagnostic_mark`. The same marks probe now answers per project and resets with the session, so one project's `defer` neither turns the check on in another project nor outlives the session that made it.
