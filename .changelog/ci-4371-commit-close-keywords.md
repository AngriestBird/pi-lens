---
section: Changed
audience: internal
---

- The close-keyword lint (`--lint-pr`) also scans every PR commit message, merge commits included, because GitHub closes an issue for a keyword in a commit that reaches master (#4371). It flags any issue a commit would close that no line-leading trailer, headline `(closes #N)`, PR title `(closes #N)` or clean body keyword names, and it fails closed when the commit list cannot be read in full.
