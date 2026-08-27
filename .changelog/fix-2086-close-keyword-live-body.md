---
section: Fixed
---

- **Read the live PR body in close-keyword verification (refs #2086)** — a post-merge rerun of `--verify-merged` used to relint the closed-event payload's stale body; it now fetches the live body, so an edit that fixes or introduces a comma-separated close list is seen on rerun.
