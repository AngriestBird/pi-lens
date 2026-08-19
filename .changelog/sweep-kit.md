---
section: Changed
---

- **Consolidate the registered-or-fail sweep machinery** — Add
  `tests/support/sweep-kit.ts`, one home for the four pieces every sweep in
  this repo hand-rolled: comment/string stripping with the string policy as a
  caller option, registry semantics (registered-or-fail, exemptions that
  require a reason, stale-entry self-detection), tag and evidence binding
  (one seam per tag, call-shaped needles, nearest-exclusive assignment), and
  the emptiness guard that fails a scan matching nothing. The kit's doc names
  the attack catalogue the finding-delivery gate paid four review rounds to
  learn, and its test suite carries one named fixture per attack. The
  session-state conformance sweep now runs on the kit.
