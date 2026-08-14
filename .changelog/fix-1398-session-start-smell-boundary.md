---
section: Fixed
---

- **Scope session-start smell-tail diagnostics to the current session boundary (closes #1398)** — historical failures in the bounded bus-events and latency log tails are no longer reported as current; rows must have a parseable UTC timestamp at or after session start.
