---
section: Fixed
audience: internal
---

- A lockfile-completeness gate that hits its npm timeout now stays inconclusive with the reason `timed out after <budget>ms` instead of `npm pin unavailable`, and the CLI line prints that reason; an acquisition outage still reads `npm pin unavailable` (#4995).
