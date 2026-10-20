---
section: Fixed
audience: user
---

- **detekt findings reach the agent again: its text report has no severity token (#4522)** —
  detekt's console report is `file:line:col: message [Rule]`, but the parser required a
  `warning:`/`error:` level, so a project with a `detekt.yml` read as clean
  instead of reporting its findings. The level is now optional, and detekt 1.23.8's
  real bytes are replayed from a captured fixture.
