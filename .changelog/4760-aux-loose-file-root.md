---
section: Fixed
audience: user
---

- **A loose file now roots the auxiliary scanners at its own directory, not at the session `$HOME`.** Opengrep, ast-grep, zizmor, and typos no longer spend five 15-second initialize timeouts (and latch the scanner broken for the session) when pi's cwd is `$HOME`; a file directly in `$HOME` is declined once, by policy, before any process starts (#4760).
