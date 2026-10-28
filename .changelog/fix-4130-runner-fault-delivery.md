---
section: Fixed
audience: user
---

- **A slow runner that could not read its tool's output is reported once, as a failure, and never blocks (refs #4130)** — a collect-later runner fault reached the agent twice at turn end (the failure note and its own synthetic diagnostic), and the cue and gleam faults carried blocking severity, so a tool that could not parse its output entered the blocker map and stopped `git commit`. Runner faults are now built at one seam as non-blocking warnings, and the deferred verdict drops them because the failure note already says it.
