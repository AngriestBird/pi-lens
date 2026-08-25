---
section: Fixed
---

- **Budget CI test workers against real memory, and name an OOM kill (refs #2042)** — Fork concurrency and the per-fork heap ceiling now come from one resolver that sizes them against the host's memory instead of two constants tuned on a dev host, and the CI suite runs under a memory watch that reports the low-water mark so exit 137 no longer reads as unattributable infrastructure noise.
