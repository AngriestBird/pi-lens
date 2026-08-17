---
section: Fixed
---

- **A tool tier degraded by a transient stall no longer survives 24h across process restarts ([#1569](https://github.com/apmantza/pi-lens/issues/1569))** — `getToolPath`'s persistent probe cache (`~/.pi-lens/probe-cache.json`) recorded only the winning path, with no memory of whether a preferred candidate along the way had merely stalled rather than proven broken. A `--version` probe that timed out, was killed, or hit an unspawnable-process glitch (Windows `spawn UNKNOWN`, EAGAIN/EBUSY) fell through to a lower-priority tier exactly like a genuine absence, and that degraded selection was then trusted for the full 24h TTL — with no session reset touching it, since the cache outlives the process. The persisted entry now carries whether any candidate was transient at selection time, and a tainted entry ages out after the shared transient cooldown (5 min) instead of the full TTL, so a process restarting minutes later re-probes instead of inheriting the stall.
