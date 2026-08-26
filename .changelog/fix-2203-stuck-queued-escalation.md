---
section: Fixed
---

- **Escalate workflow runs stuck queued (closes #2203)** — the merge-train warden classified a run that GitHub queued and never scheduled as `runs-in-progress` on every cycle forever, which read as healthy waiting. A tracked run that has executed zero steps for 60 minutes now classifies `stalled-run`: the warden names it in a PR comment, cancels it on the next cycle, and re-runs it once, bounded by GitHub's own `run_attempt`. A run with executed steps stays in progress however long it takes, and a cancellation the warden did not make is left alone.
