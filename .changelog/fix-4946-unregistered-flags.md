---
section: Fixed
audience: user
---

- **`--no-zizmor`, `--no-typos` and `--lens-spotbugs` now exist, with `*.enabled` config keys.** The zizmor and typos servers read kill switches the registry never registered, so neither could be switched off. SpotBugs was documented as opt-in behind a flag that did not exist, so it never ran; it stays off unless you set the flag or `spotbugs.enabled=true` (refs #4946).
