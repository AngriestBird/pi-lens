---
section: Fixed
audience: user
---

- **Managed tool installs refuse a bin directory that links out of a pinned `PI_LENS_HOME`** — with `PI_LENS_HOME` set, an install whose `bin` directory resolves outside that home (a symlink to another directory) no longer writes the downloaded binary through the link: it records one `managed-tool-install` row and fails the install, instead of replacing the file the link points at (a probe overwrote a real `~/.pi-lens/bin/opengrep` that way). With no `PI_LENS_HOME`, a linked default `~/.pi-lens/bin` is still honored.
