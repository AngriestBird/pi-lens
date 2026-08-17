---
section: Fixed
---

- **A repeatedly timing-out `go install` no longer re-compiles govulncheck every few minutes forever (closes #1497)** — #1489 rightly made a timed-out install transient, but it inherited the probe-class retry schedule (30 s doubling, capped at 5 min), calibrated for a 1.5–5 s version probe. On a host where the 60 s `go install` reliably exceeds its budget, steady state was a 60 s compile every 5 minutes with no terminal state. Install-class transient failures now escalate on their own schedule (5 min base, doubling, 30 min cap) and latch for the session after 3 attempts; a session reset or a successful run re-arms them, so a genuinely transient network failure still recovers. The terminal verdict is recorded in the degradation ledger (`install-retry-exhausted`, visible via `pilens_health`) and the `availability_decision` log record, since the user-visible symptom is a busy core, not a missing tool.
