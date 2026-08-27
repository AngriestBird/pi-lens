---
section: Fixed
---

- **Read the live PR body in close-keyword verification (refs #2086)** — a post-merge rerun of `--verify-merged` used to relint the closed-event payload's stale body and, in production, silently kept doing so because the workflow step never carried the `GITHUB_TOKEN` env var the live fetch needs. It now sets that var and fails the check loud on any fetch problem instead of falling back to stale data, so an edit that fixes or introduces a comma-separated close list is reliably seen on rerun.
