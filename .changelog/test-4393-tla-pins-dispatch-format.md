---
section: Added
audience: internal
---

- The 37 code-choice constants of `formal/dispatch-pipeline` and `formal/format-drain` are now pinned in `formal/switch-pins.json`, each to a live test that drives the real code, and both families join `FULLY_PINNED` (#4393). A new test pins the target hold of a whole-package fixer, which no test asserted. `tests/config/tla-switch-pins.test.ts` now compares a constant only with the pass configs of modules that name it, so a family with two modules can be pinned.
