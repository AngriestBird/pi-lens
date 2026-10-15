---
section: Fixed
audience: user
---

- **A dead export an edit introduced is no longer missed when turn end joins an older knip scan (closes #4166)**. A knip scan can already be running when the turn's edits land: the previous turn's slow scan, or a `lens_diagnostics` fetch. Turn end took that scan's answer as covering the edits and stored it as the baseline, so an export the edit left unused was never reported. Turn end still delivers that scan's findings. It now also carries the turn's files to the root's next successful scan, which reports what the edits added. The knip row in `latency.log` gains `joined` and `carried` for that turn.
