---
section: Fixed
---

- **Persist degradation-ledger decisions in `latency.log`** — every accepted
  once-record and every tally increment now writes a bounded
  `degradation_ledger` row with its kind, subject, and current count. Scanner
  coverage gaps and stalled LSP notify barriers now enter the ledger too, so a
  session remains auditable even when no degradation summary reaches the
  transcript.
