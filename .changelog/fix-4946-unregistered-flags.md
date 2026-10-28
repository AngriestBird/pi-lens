---
section: Fixed
audience: user
---

- **`--no-zizmor`, `--no-typos` and `--lens-spotbugs` now exist, with `zizmor.enabled`, `typos.enabled` and `spotbugs.enabled` in the global config.** The zizmor and typos servers read kill switches the registry never registered, so neither could be switched off, and SpotBugs was documented as opt-in behind a flag that did not exist, so it never ran; SpotBugs stays off unless you set the flag or `spotbugs.enabled=true` (refs #4946).
