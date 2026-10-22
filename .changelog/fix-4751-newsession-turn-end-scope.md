---
section: Fixed
audience: user
---

- **A session started with `/new`, `/fork` or a resume now gets its own turn-end findings (#4751)** — after pi replaced a session in the same process, pi-lens still read the turn-state worklist as the first session's, filed the new session's edits where its turn end never looked, and reported "no modified files": no turn-end findings reached the model and no turn-end blocker section reached the `--lens-guard` record. The new session now takes the worklist over at its turn start, keeping any work its predecessor left, and one `session_handoff_turn_state` row in `latency.log` records each hand-off.
