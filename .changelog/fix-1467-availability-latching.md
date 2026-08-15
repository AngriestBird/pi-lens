---
section: Fixed
---

- **A slow tool check no longer disables an installed tool for the whole session (closes #1467)** — When the check for knip, madge, govulncheck, or vulture timed out, pi-lens remembered the tool as unavailable until you restarted, and told you to install a tool that was already installed. Knip produced no findings for weeks because of this. A timed-out check is now retried after a short wait, the message says the check timed out instead of naming the wrong cause, a failed run keeps the last good cached findings instead of overwriting them, and each decision is recorded in `latency.log` as an `availability_decision` entry with its cause and timing.
