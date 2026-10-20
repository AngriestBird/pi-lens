---
section: Fixed
audience: user
---

- **detekt findings reach the agent again: its text report has no severity token (#4522)** —
  detekt's `txt` report is `file:line:col: message [Rule]`, but the parser required a
  `warning:`/`error:` level, so a project with a `detekt.yml` reported a parse
  break instead of its findings. The level is now optional, and detekt 1.23.8's
  real bytes are replayed from a captured fixture.
