---
section: Fixed
audience: user
---

- **A loose file now roots the auxiliary scanners at its own directory, not at the session `$HOME`.** Opengrep, ast-grep, zizmor, and typos no longer spend five 15-second initialize timeouts (and latch the scanner broken for the session) when pi's cwd is `$HOME`. A file whose scanner root would be `$HOME` or above it (a file directly in `$HOME`, one in an excluded directory such as `~/testdata`, or a dotfiles checkout at `$HOME`, under any symlinked spelling of `$HOME`) is declined once, by policy, before any process starts (#4760).
