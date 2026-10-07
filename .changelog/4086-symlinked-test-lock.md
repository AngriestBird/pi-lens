---
section: Fixed
audience: internal
---

- The pre-push targeted-test selector and test lock now resolve their own
  entry-point paths through symlinks, so a linked `scripts/` directory runs
  Vitest instead of silently exiting successfully without executing tests.
