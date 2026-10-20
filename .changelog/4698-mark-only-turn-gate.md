---
section: Fixed
audience: user
---

- **`--lens-guard` now opens for a blocker you marked false-positive on a turn that wrote no file**: the commit gate re-judges its latch on a turn whose only action is `lens_diagnostic_mark`, instead of keeping the marked blocker and refusing the next commit until some later turn edited a file.
