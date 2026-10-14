---
section: Changed
audience: internal
---

- The close-keyword lint (`--lint-pr`) also scans every PR commit message, merge commits included, because GitHub closes an issue for a keyword in a commit that reaches master (#4371). It flags any issue a commit would close that the PR title or a clean body keyword does not close, so a commit trailer alone is not intent, and it fails closed when the commit list cannot be read in full. The PR-metadata scripts now share one GitHub REST read, `scripts/lib/github-rest.mjs`.
