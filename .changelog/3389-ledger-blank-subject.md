---
section: Fixed
---

- A degradation row whose subject is blank now reads `unknown` instead of
  rendering as `⚠ <kind>: 1 — : <reason>` with an empty discriminator, and its
  once-latch and tally key agree with the row. Any subject that normalizes to
  empty or whitespace is folded at the ledger's write paths; metadata values and
  reasons are untouched, so a genuinely empty value is still recorded as itself
  (refs #3389).
