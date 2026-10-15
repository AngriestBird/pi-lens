---
section: Fixed
audience: user
---

- **A dead export an edit introduced is no longer missed when turn end joins an older knip scan (closes #4166)** — When a knip scan was already running before the turn's edits (the previous turn's slow scan, another session's, or a `lens_diagnostics` fetch), turn end took its answer as the edit's and stored it as the baseline, so an export the edit left unused was never reported. Turn end now withholds that answer, carries the turn's files, and the root's next successful scan attributes them with its own. The knip row in `latency.log` gains `joined` and `carried` for that turn.
