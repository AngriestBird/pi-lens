---
section: Fixed
audience: internal
---

- **The continue-on-error census now covers the whole workflow tree (refs #4518)** — every `continue-on-error` site outside the LSP nightly is registered in `tests/fixtures/nightly-floors/continue-on-error-sites.json` as floored (naming the gating step) or excluded with the reader that makes an empty result visible, and the test derives the population from the workflows so an unregistered site fails closed. The Swift crash-watch step also prints `evaluated=<0|1>` to its log, so a night read from the job log alone states whether swift was evaluated.
