---
section: Fixed
audience: user
---

- **A demoted blocker now honours your marks and stops re-serving dead coordinates:** a `[stale — re-run to confirm]` advisory runs the same disposition policy as the live blocker channel, so a `false-positive` or `suppress` mark silences it, and a `self-drift` record the agent fixed by rewriting the file retires after `SELF_DRIFT_MAX_DELIVERIES` deliveries with a "re-run can still confirm" reason. A confirmed-clean verdict that covers only some of a record's sources now retires the source rows it spoke for instead of leaving the whole record, dead coordinates included, to re-serve for the rest of the session (refs #4990).
