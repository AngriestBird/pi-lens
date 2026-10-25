---
section: Fixed
audience: internal
---

- **Keep the nightly's staged `.changelog/` fragment in the promotion artifact.** `tool-smoke`'s PR-input upload now sets `include-hidden-files: true`, because `actions/upload-artifact` v4.4+ drops every name that starts with `.` and the promotion PR then failed on `pathspec '.changelog/…' did not match any files`; a new workflow pin derives the staged set of every upload step and reds when one of them drops a dot path (#3952).
