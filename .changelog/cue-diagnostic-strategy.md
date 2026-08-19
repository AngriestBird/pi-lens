---
section: Fixed
---

- **cuelsp's silent clean-open no longer reads as inconclusive (refs #1522, #1519)** — Measured directly against the real `cue lsp serve` v0.17.1 binary: a cold `didOpen` on an already-clean `.cue` file publishes nothing at all inside the wait budget, so a touch used to time out and report `inconclusive`. `SERVER_DIAGNOSTIC_STRATEGIES.cue` now marks it `silentOnClean`, so the shared push-only clean-confirm gate reads "no publish, notify succeeded" as confirmed clean — matching the behavior already shipped for typescript and marksman. An edited document still publishes normally (both the error and the empty array that clears it), so this only changes the cold-open case.
