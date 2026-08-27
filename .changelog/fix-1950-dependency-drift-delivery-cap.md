---
section: Fixed
---

- **Cap dependency-drift blocker re-serves (refs #1950)** — A demoted-but-confirmable inline blocker (`clients/blocker-freshness.ts`) now retires after 3 degraded deliveries with no re-run, instead of re-serving indefinitely. The retirement note says the record can still be confirmed by a fresh dispatch, distinct from #1944's past-EOF retirement, which means the finding is provably unconfirmable.
