---
section: Fixed
---

- **Stop metrics-history's git probe from leaking stderr into the TUI (#2095)** — `getCurrentCommit()` now pipes `git rev-parse` stderr instead of inheriting it, so a failing probe reports "unknown" quietly instead of printing a raw `fatal:` line. The same fix applies to the LSP launcher's Windows registry PATH probe, the only other unguarded `execSync`/`execFileSync` call in the runtime.
