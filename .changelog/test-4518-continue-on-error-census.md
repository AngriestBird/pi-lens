---
section: Fixed
audience: internal
---

- **The continue-on-error census now covers the whole producer tree (refs #4518)** — every `continue-on-error` site in `.github/workflows/*.{yml,yaml}` and in a composite `.github/actions/**/action.{yml,yaml}` is registered in `tests/fixtures/nightly-floors/continue-on-error-sites.json` as floored (naming the gating step, whose live run text must carry the floor), no-floor (the reader that makes an empty result visible), or governed-by (the issue and tests that own it). The test derives the population from the parsed files and fails closed on an unregistered site, a producer file it cannot classify, a key outside a job or step, and a floor whose only evidence is a comment, a quoted command or a heredoc body, and on a floor step whose `if:` names no condition the runner can reach. The Swift crash-watch step also prints `evaluated=<0|1>` to its log, so a night read from the job log alone states whether swift was evaluated.
